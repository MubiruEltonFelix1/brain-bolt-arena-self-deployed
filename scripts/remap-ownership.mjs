// Collapse all 5 old host accounts' content into the newly re-registered admin account.
// Usage: node remap-ownership.mjs [email]   (default: mubirueltonfelix@gmail.com)
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = {};
for (const line of readFileSync(join(ROOT, ".env.migration"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) vars[m[1]] = m[2];
}
const PSQL = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const CONN = vars.NEW_DB_CONNECTION_STRING;
const EMAIL = process.argv[2] ?? "mubirueltonfelix@gmail.com";

function q(sql) {
  const r = spawnSync(PSQL, [CONN, "-t", "-A", "-c", sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("psql failed: " + r.stderr.slice(0, 600));
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

// 1. Resolve the new admin uid
const uidRows = q(`SELECT id FROM auth.users WHERE email = '${EMAIL.replace(/'/g, "''")}'`);
if (!uidRows.length) {
  console.error(`No auth user found for "${EMAIL}". Create the account first (dashboard -> Authentication -> Users -> Add user).`);
  process.exit(1);
}
const NEW = uidRows[0];
console.log(`new admin uid: ${NEW} (${EMAIL})`);

// 2. Old uids from the restored principals
const OLDS = q("SELECT id FROM public.principals WHERE type = 'user'").filter((x) => x !== NEW);
console.log(`old uids to remap (${OLDS.length}): ${OLDS.join(", ")}`);
if (!OLDS.length) { console.log("Nothing to remap."); process.exit(0); }
const inOlds = `('${OLDS.join("','")}')`;

const sql = `
BEGIN;

-- Drop the owner_principal_id FKs (recreated at the end)
ALTER TABLE public.quizzes DROP CONSTRAINT IF EXISTS quizzes_owner_principal_id_fkey;
ALTER TABLE public.leagues DROP CONSTRAINT IF EXISTS leagues_owner_principal_id_fkey;
ALTER TABLE public.branding_profiles DROP CONSTRAINT IF EXISTS branding_profiles_owner_principal_id_fkey;

-- Disable triggers that would block or recompute during the remap
ALTER TABLE public.principals DISABLE TRIGGER principals_immutable_trg;
ALTER TABLE public.quizzes DISABLE TRIGGER quizzes_sync_owner_principal_trg;
ALTER TABLE public.leagues DISABLE TRIGGER leagues_sync_owner_principal_trg;
ALTER TABLE public.branding_profiles DISABLE TRIGGER branding_sync_owner_principal_trg;
ALTER TABLE public.sessions DISABLE TRIGGER enforce_host_authorization_trg;

-- Confirm the email so the admin can log in immediately
UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) WHERE id = '${NEW}';

-- Roles: point at the new uid
UPDATE public.user_roles SET user_id = '${NEW}' WHERE user_id IN ${inOlds};
UPDATE public.user_roles SET granted_by = '${NEW}' WHERE granted_by IN ${inOlds};
UPDATE public.host_requests SET user_id = '${NEW}' WHERE user_id IN ${inOlds};
UPDATE public.host_requests SET reviewed_by = '${NEW}' WHERE reviewed_by IN ${inOlds};
UPDATE public.host_authorizations SET profile_id = '${NEW}' WHERE profile_id IN ${inOlds};
UPDATE public.host_authorizations SET granted_by = '${NEW}' WHERE granted_by IN ${inOlds};
UPDATE public.result_claims SET claimed_by = '${NEW}' WHERE claimed_by IN ${inOlds};

-- Content tables
UPDATE public.quizzes SET owner_id = '${NEW}', owner_principal_id = '${NEW}' WHERE owner_id IN ${inOlds} OR owner_principal_id IN ${inOlds};
UPDATE public.leagues SET owner_id = '${NEW}', owner_principal_id = '${NEW}' WHERE owner_id IN ${inOlds} OR owner_principal_id IN ${inOlds};
UPDATE public.branding_profiles SET owner_id = '${NEW}', owner_principal_id = '${NEW}' WHERE owner_id IN ${inOlds} OR owner_principal_id IN ${inOlds};
UPDATE public.competitions SET owner_id = '${NEW}' WHERE owner_id IN ${inOlds};
UPDATE public.sessions SET host_id = '${NEW}' WHERE host_id IN ${inOlds};

-- Drop the old identity rows (the new account's profile+principal were created by the signup trigger)
DELETE FROM public.profiles WHERE id IN ${inOlds};
DELETE FROM public.principals WHERE id IN ${inOlds};

-- Recreate the FKs
ALTER TABLE public.quizzes ADD CONSTRAINT quizzes_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;
ALTER TABLE public.leagues ADD CONSTRAINT leagues_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;
ALTER TABLE public.branding_profiles ADD CONSTRAINT branding_profiles_owner_principal_id_fkey FOREIGN KEY (owner_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

-- Re-enable triggers
ALTER TABLE public.principals ENABLE TRIGGER principals_immutable_trg;
ALTER TABLE public.quizzes ENABLE TRIGGER quizzes_sync_owner_principal_trg;
ALTER TABLE public.leagues ENABLE TRIGGER leagues_sync_owner_principal_trg;
ALTER TABLE public.branding_profiles ENABLE TRIGGER branding_sync_owner_principal_trg;
ALTER TABLE public.sessions ENABLE TRIGGER enforce_host_authorization_trg;

COMMIT;
`;

const sqlPath = join(ROOT, "scripts", "remap.sql");
writeFileSync(sqlPath, sql);
const r = spawnSync(PSQL, [CONN, "-v", "ON_ERROR_STOP=1", "-f", sqlPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
console.log(r.stdout ? r.stdout.slice(0, 4000) : "");
if (r.status !== 0) {
  console.error("REMAP FAILED:\n" + (r.stderr || "").slice(0, 3000));
  process.exit(1);
}
console.log("REMAP OK");

// Verify
console.log("\n--- VERIFY ---");
console.log("quizzes owned:", q(`SELECT count(*) FROM public.quizzes WHERE owner_id = '${NEW}'`)[0], "/", q("SELECT count(*) FROM public.quizzes")[0]);
console.log("leagues owned:", q(`SELECT count(*) FROM public.leagues WHERE owner_id = '${NEW}'`)[0], "/", q("SELECT count(*) FROM public.leagues")[0]);
console.log("sessions hosted:", q(`SELECT count(*) FROM public.sessions WHERE host_id = '${NEW}'`)[0]);
console.log("principals:", q("SELECT count(*) FROM public.principals")[0], "(expect 1)");
console.log("user_roles:", q(`SELECT role FROM public.user_roles WHERE user_id = '${NEW}'`).join(","), "(expect admin)");
console.log("orphans (owner_id not in auth.users):", q("SELECT count(*) FROM public.quizzes WHERE owner_id NOT IN (SELECT id FROM auth.users)")[0]);
