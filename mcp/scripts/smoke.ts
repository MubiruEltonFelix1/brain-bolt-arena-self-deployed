#!/usr/bin/env bun
// Bwat's test client for the Brain Bolt MCP server.
//
// Boots the server as a child process over stdio and exercises every tool:
//   get_capabilities, validate_quiz, to_csv, save_quiz, the Phase 8B
//   lifecycle tools (list_quizzes, get_quiz, update_quiz, archive_quiz,
//   question management), the Phase 8C competition tools (list_competitions,
//   get_competition, create_competition, update_competition,
//   schedule_competition, cancel_competition), the Phase 8D league tools
//   (list_leagues, get_league, get_league_standings, list_league_competitions,
//   get_competition_results, get_player_league_history, attach/detach) and
//   orchestrate_competition_workflow, plus generate_quiz when an LLM provider
//   is configured in mcp/.env (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).
//
// Discovery is dynamic: the core + lifecycle + competition + league +
// orchestration tool names are asserted against the server's own listTools()
// so future tools don't break the smoke test.
//
// With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + BRAINBOLT_DEFAULT_OWNER_ID
// set, the smoke runs a full lifecycle against the real database:
//   create (idempotent) → list → get → update → get → archive → verify
//   + repeated idempotent create/update replay,
//   + competition create (idempotent) → get → update → schedule → get →
//     cancel → get (the scheduled handoff is verified by state: the pg_cron
//     tick cannot be driven from the client).
// Without them, every Supabase-backed tool is gate-checked instead.
//
// Run with: bun run smoke   (from mcp/)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const FIXTURE = {
  title: "Solar System Smash",
  description: "Smoke fixture",
  timePerQuestionSec: 20,
  difficulty: "medium",
  questions: [
    {
      type: "mcq",
      text: "Which planet is known as the Red Planet?",
      options: ["Venus", "Mars", "Jupiter", "Mercury"],
      correctIndex: 1,
    },
    { type: "true_false", text: "The Earth is round.", correct: true },
    {
      type: "number",
      text: "In what year did humans first land on the Moon?",
      correctNumber: 1969,
      min: 1900,
      max: 2000,
      format: "year",
    },
    {
      type: "map_pin",
      text: "Drop a pin on Tokyo",
      lat: 35.6762,
      lng: 139.6503,
      maxDistanceKm: 400,
    },
    {
      type: "type",
      text: "Which fruit keeps the doctor away?",
      acceptedAnswers: ["apple", "an apple", "apples"],
    },
    {
      type: "ordering",
      text: "Planets from the Sun",
      items: ["Mercury", "Venus", "Earth", "Mars"],
    },
  ],
};

const CORE_TOOLS = ["get_capabilities", "generate_quiz", "validate_quiz", "to_csv", "save_quiz"];
const LIFECYCLE_TOOLS = [
  "list_quizzes",
  "get_quiz",
  "update_quiz",
  "archive_quiz",
  "add_questions",
  "update_question",
  "remove_question",
  "reorder_questions",
];
const COMPETITION_TOOLS = [
  "list_competitions",
  "get_competition",
  "create_competition",
  "update_competition",
  "schedule_competition",
  "cancel_competition",
];
const LEAGUE_TOOLS = [
  "list_leagues",
  "get_league",
  "get_league_standings",
  "list_league_competitions",
  "attach_competition_to_league",
  "detach_competition_from_league",
];
const RESULTS_TOOLS = ["get_competition_results", "get_player_league_history"];
const ORCHESTRATE_TOOLS = ["orchestrate_competition_workflow"];

let passed = 0;
let failed = 0;

function ok(label: string): void {
  passed++;
  console.log(`✓ ${label}`);
}

function bad(label: string, detail?: string): void {
  failed++;
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

// The SDK's callTool return type is an anonymous index-signature object that
// doesn't structurally match its exported CallToolResult — accept unknown and
// narrow to what this test client reads.
function resultText(res: unknown): { text: string; isError: boolean } {
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return { text, isError: Boolean(r.isError) };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return resultText(await client.callTool({ name, arguments: args }));
}

const mcpDir = fileURLToPath(new URL("../", import.meta.url));

// The SDK only inherits a whitelist of env vars on Windows — pass everything
// so LLM_BASE_URL/LLM_MODEL/LLM_API_KEY set for the smoke run reach the child.
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) childEnv[k] = v;
}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/index.ts"],
  cwd: mcpDir,
  stderr: "pipe",
  env: childEnv,
});

transport.stderr?.on("data", (chunk: Buffer) => {
  process.stderr.write(`[server] ${chunk.toString()}`);
});

const client = new Client({ name: "brainbolt-test-client", version: "0.1.0" });

async function main() {
  await client.connect(transport);
  ok("connected to brainbolt-mcp over stdio");

  // --- Dynamic tool discovery ---------------------------------------------
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  const required = [
    ...CORE_TOOLS,
    ...LIFECYCLE_TOOLS,
    ...COMPETITION_TOOLS,
    ...LEAGUE_TOOLS,
    ...RESULTS_TOOLS,
    ...ORCHESTRATE_TOOLS,
  ];
  const missing = required.filter((r) => !names.includes(r));
  if (missing.length === 0) {
    ok(`all ${required.length} core + lifecycle + competition + league + orchestration tools registered (${names.length} total)`);
  } else {
    bad(`missing tools: ${missing.join(", ")} — got ${names.join(", ")}`);
  }

  // --- get_capabilities ---------------------------------------------------
  const caps = await callTool(client, "get_capabilities", {});
  const capsData = JSON.parse(caps.text);
  const lifecycleOk =
    capsData.lifecycle?.tools?.length === LIFECYCLE_TOOLS.length &&
    capsData.lifecycle?.idempotency?.mechanism?.includes("mcp_idempotency_keys") &&
    capsData.lifecycle?.ownership?.actorResolution?.includes("public.can");
  if (
    capsData.questionTypes?.length === 10 &&
    capsData.csvTemplateHeader?.startsWith("question_type,question") &&
    capsData.limits?.questionCount?.max === 30 &&
    capsData.limits?.quizTimePerQuestionSec?.max === 120 &&
    capsData.mediaPolicy?.missingUrlIsError === true &&
    capsData.ownerRequirements?.ownerMustHaveUserPrincipal === true
  ) {
    ok(`get_capabilities: ${capsData.questionTypes.length} question types + limits + media policy + owner requirements`);
  } else {
    bad("get_capabilities shape", caps.text.slice(0, 400));
  }
  if (lifecycleOk) {
    ok("get_capabilities: lifecycle section (tools + filters + idempotency + ownership)");
  } else {
    bad("get_capabilities lifecycle section", caps.text.slice(0, 400));
  }

  const competitionsOk =
    capsData.competitions?.tools?.length === COMPETITION_TOOLS.length &&
    capsData.competitions?.authorization?.create?.includes("competition.create") &&
    capsData.competitions?.authorization?.manage?.includes("competition.manage") &&
    capsData.competitions?.sessionBoundary?.rule?.includes("sessions") &&
    capsData.competitions?.idempotency?.tools?.includes("schedule_competition");
  if (competitionsOk) {
    ok("get_capabilities: competitions section (tools + authorization + session boundary + idempotency)");
  } else {
    bad("get_capabilities competitions section", caps.text.slice(0, 400));
  }

  const leaguesOk =
    capsData.leagues?.tools?.length === LEAGUE_TOOLS.length &&
    capsData.leagues?.standings?.source?.includes("mcp_league_standings") &&
    capsData.leagues?.authorization?.read?.includes("can_view_league") &&
    capsData.leagues?.noCreate?.includes("create_league");
  if (leaguesOk) {
    ok("get_capabilities: leagues section (tools + read gate + standings source + no create)");
  } else {
    bad("get_capabilities leagues section", caps.text.slice(0, 400));
  }

  const resultsOk =
    capsData.results?.tools?.length === RESULTS_TOOLS.length &&
    capsData.results?.source?.includes("competition_results");
  if (resultsOk) {
    ok("get_capabilities: results section (permanent results + player history)");
  } else {
    bad("get_capabilities results section", caps.text.slice(0, 400));
  }

  const orchestrationOk =
    capsData.orchestration?.tool === "orchestrate_competition_workflow" &&
    capsData.orchestration?.workflows?.create_attach_schedule?.length === 3 &&
    capsData.orchestration?.workflows?.create_schedule?.length === 2 &&
    capsData.orchestration?.idempotency?.required?.includes("REQUIRED") === true;
  if (orchestrationOk) {
    ok("get_capabilities: orchestration section (bounded workflows + required idempotency)");
  } else {
    bad("get_capabilities orchestration section", caps.text.slice(0, 400));
  }

  // --- validate_quiz ------------------------------------------------------
  const val = await callTool(client, "validate_quiz", { quiz: FIXTURE });
  const valData = JSON.parse(val.text);
  if (valData.valid === true) {
    ok(`validate_quiz: valid (${valData.warnings.length} warning(s))`);
  } else {
    bad("validate_quiz on fixture", val.text.slice(0, 300));
  }

  // --- to_csv -------------------------------------------------------------
  const csv = await callTool(client, "to_csv", { quiz: FIXTURE });
  const csvData = JSON.parse(csv.text) as { csv: string };
  const lines = csvData.csv.trim().split("\n");
  const headerCount = lines[0]!.split(",").length;
  if (lines.length === FIXTURE.questions.length + 1 && lines[1]!.startsWith("multiple_choice,")) {
    ok(`to_csv: ${lines.length - 1} rows, ${headerCount}-col header, legacy type names`);
  } else {
    bad("to_csv output", csvData.csv?.slice(0, 200));
  }

  const hasSupabase = Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const ownerId = process.env.BRAINBOLT_DEFAULT_OWNER_ID?.trim();
  const canRunLifecycle = hasSupabase && Boolean(ownerId);

  if (!hasSupabase) {
    // --- save_quiz + lifecycle gate checks (no Supabase config) -----------
    const save = await callTool(client, "save_quiz", {
      quiz: FIXTURE,
      ownerId: "00000000-0000-0000-0000-000000000000",
    });
    if (save.isError && /not configured/.test(save.text)) {
      ok("save_quiz: correctly gated (not configured)");
    } else {
      bad("save_quiz gate", save.text.slice(0, 200));
    }

    let gatesOk = true;
    const gatedTools = [
      ...LIFECYCLE_TOOLS,
      ...COMPETITION_TOOLS,
      ...LEAGUE_TOOLS,
      ...RESULTS_TOOLS,
      ...ORCHESTRATE_TOOLS,
    ];
    for (const tool of gatedTools) {
      const zeroUuid = "00000000-0000-0000-0000-000000000000";
      const args: Record<string, unknown> = (() => {
        switch (tool) {
          case "list_quizzes":
          case "list_competitions":
          case "list_leagues":
            return { actorId: zeroUuid };
          case "get_competition":
          case "schedule_competition":
          case "cancel_competition":
            return { actorId: zeroUuid, competitionId: zeroUuid };
          case "get_league":
          case "get_league_standings":
          case "list_league_competitions":
            return { actorId: zeroUuid, leagueId: zeroUuid };
          case "get_competition_results":
            return { actorId: zeroUuid, competitionId: zeroUuid };
          case "get_player_league_history":
            return { actorId: zeroUuid, leagueId: zeroUuid, profileId: zeroUuid };
          case "attach_competition_to_league":
            return { actorId: zeroUuid, competitionId: zeroUuid, leagueId: zeroUuid };
          case "detach_competition_from_league":
            return { actorId: zeroUuid, competitionId: zeroUuid };
          case "orchestrate_competition_workflow":
            return {
              actorId: zeroUuid,
              workflow: "create_schedule",
              plan: {
                quizId: zeroUuid,
                title: "x",
                mode: "scheduled",
                visibility: "private",
                scheduledStartAt: new Date(Date.now() + 3600_000).toISOString(),
              },
              idempotencyKey: "smoke-gate",
            };
          case "create_competition":
            return {
              actorId: zeroUuid,
              quizId: zeroUuid,
              title: "x",
              mode: "scheduled",
              visibility: "private",
              scheduledStartAt: new Date(Date.now() + 3600_000).toISOString(),
            };
          case "update_competition":
            return { actorId: zeroUuid, competitionId: zeroUuid, patch: { title: "x" } };
          case "reorder_questions":
            return { actorId: zeroUuid, quizId: zeroUuid, questionIds: [zeroUuid] };
          case "update_quiz":
            return { actorId: zeroUuid, quizId: zeroUuid, patch: { title: "x" } };
          case "add_questions":
            return {
              actorId: zeroUuid,
              quizId: zeroUuid,
              questions: [{ type: "mcq", text: "x", options: ["a", "b"], correctIndex: 0 }],
            };
          case "update_question":
            return { actorId: zeroUuid, quizId: zeroUuid, questionId: zeroUuid, patch: { text: "x" } };
          default:
            return { actorId: zeroUuid, quizId: zeroUuid, questionId: zeroUuid };
        }
      })();
      const res = await callTool(client, tool, args);
      if (res.isError && /not configured/.test(res.text)) {
        ok(`${tool}: correctly gated (not configured)`);
      } else {
        gatesOk = false;
        bad(`${tool} gate`, res.text.slice(0, 200));
      }
    }
    if (gatesOk) ok(`all ${gatedTools.length} quiz + competition + league + orchestration tools gated without Supabase config`);
  } else if (!ownerId) {
    bad("lifecycle smoke needs BRAINBOLT_DEFAULT_OWNER_ID (a host-capable auth user uuid) when Supabase is configured");
  } else {
    // --- save_quiz: idempotent creation -----------------------------------
    const createKey = `smoke-create-${Date.now()}`;
    const create1 = await callTool(client, "save_quiz", {
      quiz: FIXTURE,
      ownerId,
      idempotencyKey: createKey,
    });
    if (create1.isError) {
      bad("save_quiz (lifecycle create)", create1.text.slice(0, 500));
      console.log(
        "ℹ If this failed with a host-capability error: BRAINBOLT_DEFAULT_OWNER_ID must be an admin or host " +
          "(can(principal, 'quiz.create') gate).",
      );
    } else {
      const created = JSON.parse(create1.text) as {
        ok?: boolean;
        id?: string;
        quizId?: string;
        questionCount?: number;
        replayed?: boolean;
      };
      const quizId = created.quizId ?? created.id;
      if (created.ok === true && quizId && created.questionCount === FIXTURE.questions.length) {
        ok(`save_quiz: created quiz ${quizId} with ${created.questionCount} questions`);
      } else {
        bad("save_quiz result shape", create1.text.slice(0, 400));
      }

      if (quizId) {
        // Idempotent replay of the SAME create call.
        const create2 = await callTool(client, "save_quiz", {
          quiz: FIXTURE,
          ownerId,
          idempotencyKey: createKey,
        });
        const replay = JSON.parse(create2.text) as { quizId?: string; replayed?: boolean };
        if (!create2.isError && replay.quizId === quizId && replay.replayed === true) {
          ok("save_quiz: idempotent replay returned the same quizId (no duplicate)");
        } else {
          bad("save_quiz idempotent replay", create2.text.slice(0, 300));
        }

        // --- list_quizzes --------------------------------------------------
        const list = await callTool(client, "list_quizzes", {
          actorId: ownerId,
          search: "Solar System Smash",
        });
        const listData = JSON.parse(list.text) as {
          ok?: boolean;
          items?: Array<{ id: string; questionCount: number; archived: boolean }>;
        };
        const found = listData.items?.some((i) => i.id === quizId && i.questionCount === 6);
        if (listData.ok === true && found) {
          ok("list_quizzes: created quiz found with question count");
        } else {
          bad("list_quizzes", list.text.slice(0, 400));
        }

        // --- get_quiz (before update) --------------------------------------
        const get1 = await callTool(client, "get_quiz", { actorId: ownerId, quizId });
        const get1Data = JSON.parse(get1.text) as {
          ok?: boolean;
          quiz?: { title?: string };
          questions?: unknown[];
        };
        if (get1Data.ok === true && get1Data.quiz?.title === "Solar System Smash" && get1Data.questions?.length === 6) {
          ok("get_quiz: full quiz with 6 questions round-tripped");
        } else {
          bad("get_quiz", get1.text.slice(0, 400));
        }

        // --- update_quiz ----------------------------------------------------
        const updKey = `smoke-update-${Date.now()}`;
        const upd1 = await callTool(client, "update_quiz", {
          actorId: ownerId,
          quizId,
          patch: { title: "Solar System Smash (Renamed)", difficulty: "hard" },
          idempotencyKey: updKey,
        });
        const upd1Data = JSON.parse(upd1.text) as { ok?: boolean; changed?: Record<string, boolean> };
        if (upd1Data.ok === true && upd1Data.changed?.title === true && upd1Data.changed?.difficulty === true) {
          ok("update_quiz: patch applied (title + difficulty)");
        } else {
          bad("update_quiz", upd1.text.slice(0, 400));
        }

        // Idempotent replay of the SAME update.
        const upd2 = await callTool(client, "update_quiz", {
          actorId: ownerId,
          quizId,
          patch: { title: "Solar System Smash (Renamed)", difficulty: "hard" },
          idempotencyKey: updKey,
        });
        const upd2Data = JSON.parse(upd2.text) as { replayed?: boolean; changed?: Record<string, boolean> };
        if (!upd2.isError && upd2Data.replayed === true && upd2Data.changed?.title === true) {
          ok("update_quiz: idempotent replay returned the stored result (applied once)");
        } else {
          bad("update_quiz idempotent replay", upd2.text.slice(0, 300));
        }

        // --- get_quiz (after update) ----------------------------------------
        const get2 = await callTool(client, "get_quiz", { actorId: ownerId, quizId });
        const get2Data = JSON.parse(get2.text) as { quiz?: { title?: string; difficulty?: string } };
        if (get2Data.quiz?.title === "Solar System Smash (Renamed)" && get2Data.quiz?.difficulty === "hard") {
          ok("get_quiz: reflects the update");
        } else {
          bad("get_quiz after update", get2.text.slice(0, 400));
        }

        // --- competition lifecycle: create (draft) → replay → get → update → schedule → get (handoff) → cancel → get ---
        const compKey = `smoke-comp-${Date.now()}`;
        const compStart = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        const comp1 = await callTool(client, "create_competition", {
          actorId: ownerId,
          quizId,
          title: "MCP Competition Smoke",
          mode: "scheduled",
          visibility: "private",
          scheduledStartAt: compStart,
          idempotencyKey: compKey,
        });
        const comp1Data = JSON.parse(comp1.text) as { ok?: boolean; competitionId?: string; status?: string };
        const competitionId = comp1Data.competitionId;
        if (comp1Data.ok === true && competitionId && comp1Data.status === "draft") {
          ok(`create_competition: draft ${competitionId} scheduled for ${compStart}`);
        } else {
          bad("create_competition", comp1.text.slice(0, 400));
        }

        if (competitionId) {
          // Idempotent replay of the SAME create call.
          const comp2 = await callTool(client, "create_competition", {
            actorId: ownerId,
            quizId,
            title: "MCP Competition Smoke",
            mode: "scheduled",
            visibility: "private",
            scheduledStartAt: compStart,
            idempotencyKey: compKey,
          });
          const comp2Data = JSON.parse(comp2.text) as { competitionId?: string; replayed?: boolean };
          if (!comp2.isError && comp2Data.competitionId === competitionId && comp2Data.replayed === true) {
            ok("create_competition: idempotent replay returned the same competitionId (no duplicate)");
          } else {
            bad("create_competition idempotent replay", comp2.text.slice(0, 300));
          }

          // get_competition (draft)
          const cget1 = await callTool(client, "get_competition", { actorId: ownerId, competitionId });
          const cget1Data = JSON.parse(cget1.text) as { ok?: boolean; competition?: { status?: string } };
          if (cget1Data.ok === true && cget1Data.competition?.status === "draft") {
            ok("get_competition: draft state");
          } else {
            bad("get_competition", cget1.text.slice(0, 400));
          }

          // update_competition (patch)
          const cupd = await callTool(client, "update_competition", {
            actorId: ownerId,
            competitionId,
            patch: { title: "MCP Competition Smoke (Updated)", visibility: "unlisted" },
          });
          const cupdData = JSON.parse(cupd.text) as { ok?: boolean; changed?: Record<string, boolean> };
          if (cupdData.ok === true && cupdData.changed?.title === true && cupdData.changed?.visibility === true) {
            ok("update_competition: patch applied (title + visibility)");
          } else {
            bad("update_competition", cupd.text.slice(0, 400));
          }

          // --- league reads + attach/detach + orchestration (Phase 8D) -------
          // The main competition is still DRAFT here, so attach/detach can be
          // exercised on it without disturbing the schedule flow below.
          const llist = await callTool(client, "list_leagues", {
            actorId: ownerId,
            ownerOnly: true,
          });
          const llistData = JSON.parse(llist.text) as {
            ok?: boolean;
            count?: number;
            items?: Array<{ id: string; archivedAt?: string | null }>;
          };
          if (llistData.ok === true && Array.isArray(llistData.items)) {
            ok(`list_leagues: owner-scoped list (${llistData.count} league(s))`);
          } else {
            bad("list_leagues", llist.text.slice(0, 400));
          }

          const ownedLeague = llistData.items?.find((l) => !l.archivedAt);
          if (!ownedLeague) {
            console.log(
              "ℹ No owned, non-archived league found — skipping league-read + attach + orchestrate live checks " +
                "(create a league for the owner in the app first).",
            );
          } else {
            const leagueId = ownedLeague.id;

            const gleague = await callTool(client, "get_league", { actorId: ownerId, leagueId });
            const gleagueData = JSON.parse(gleague.text) as { ok?: boolean; league?: { id?: string } };
            if (gleagueData.ok === true && gleagueData.league?.id === leagueId) {
              ok("get_league: metadata + season overview round-tripped");
            } else {
              bad("get_league", gleague.text.slice(0, 400));
            }

            // Standings go through the Phase 8D service-role wrapper — this
            // fails with a structured error until the 8D migration is applied.
            const stand = await callTool(client, "get_league_standings", { actorId: ownerId, leagueId });
            const standData = JSON.parse(stand.text) as { ok?: boolean; count?: number; standings?: unknown[] };
            if (standData.ok === true && typeof standData.count === "number") {
              ok(`get_league_standings: live computation via mcp_league_standings (${standData.count} row(s))`);
            } else {
              bad("get_league_standings", stand.text.slice(0, 400));
            }

            const lcomp = await callTool(client, "list_league_competitions", { actorId: ownerId, leagueId });
            const lcompData = JSON.parse(lcomp.text) as { ok?: boolean; count?: number };
            if (lcompData.ok === true && typeof lcompData.count === "number") {
              ok(`list_league_competitions: ${lcompData.count} attached competition(s)`);
            } else {
              bad("list_league_competitions", lcomp.text.slice(0, 400));
            }

            // Self-read: the owner reads their own league history (allowed even
            // in private leagues); zero entries is a valid outcome.
            const hist = await callTool(client, "get_player_league_history", {
              actorId: ownerId,
              leagueId,
              profileId: ownerId,
            });
            const histData = JSON.parse(hist.text) as { ok?: boolean; competitionsEntered?: number };
            if (histData.ok === true && typeof histData.competitionsEntered === "number") {
              ok(`get_player_league_history: ${histData.competitionsEntered} competition(s) on record`);
            } else {
              bad("get_player_league_history", hist.text.slice(0, 400));
            }

            // attach (draft competition) → idempotent replay → detach
            const attachKey = `smoke-comp-attach-${Date.now()}`;
            const attach1 = await callTool(client, "attach_competition_to_league", {
              actorId: ownerId,
              competitionId,
              leagueId,
              idempotencyKey: attachKey,
            });
            const attach1Data = JSON.parse(attach1.text) as { ok?: boolean; leagueId?: string | null };
            if (attach1Data.ok === true && attach1Data.leagueId === leagueId) {
              ok("attach_competition_to_league: draft competition attached");
              const attach2 = await callTool(client, "attach_competition_to_league", {
                actorId: ownerId,
                competitionId,
                leagueId,
                idempotencyKey: attachKey,
              });
              const attach2Data = JSON.parse(attach2.text) as { replayed?: boolean };
              if (!attach2.isError && attach2Data.replayed === true) {
                ok("attach_competition_to_league: idempotent replay (attached once)");
              } else {
                bad("attach_competition_to_league idempotent replay", attach2.text.slice(0, 300));
              }
            } else {
              bad("attach_competition_to_league", attach1.text.slice(0, 400));
            }

            const detach1 = await callTool(client, "detach_competition_from_league", {
              actorId: ownerId,
              competitionId,
              idempotencyKey: `smoke-comp-detach-${Date.now()}`,
            });
            const detach1Data = JSON.parse(detach1.text) as { ok?: boolean; leagueId?: string | null };
            if (detach1Data.ok === true && detach1Data.leagueId === null) {
              ok("detach_competition_from_league: competition detached again");
            } else {
              bad("detach_competition_from_league", detach1.text.slice(0, 400));
            }

            // orchestrate create_attach_schedule → verify → replay → detach →
            // cancel. The orchestrated competition is detached while still
            // scheduled (detach is protected once cancelled) and then
            // cancelled, so the league is left exactly as it was.
            const orchKey = `smoke-orch-${Date.now()}`;
            const orchArgs = {
              actorId: ownerId,
              workflow: "create_attach_schedule" as const,
              plan: {
                quizId,
                title: "MCP Orchestration Smoke",
                mode: "scheduled" as const,
                visibility: "unlisted" as const,
                scheduledStartAt: compStart,
                leagueId,
              },
              idempotencyKey: orchKey,
            };
            const orch1 = await callTool(client, "orchestrate_competition_workflow", orchArgs);
            const orch1Data = JSON.parse(orch1.text) as {
              ok?: boolean;
              status?: string;
              competitionId?: string;
              steps?: Array<{ step?: number; tool?: string; status?: string }>;
            };
            const orchCompetitionId = orch1Data.competitionId;
            if (
              orch1Data.ok === true &&
              orch1Data.status === "completed" &&
              orch1Data.steps?.length === 3 &&
              orch1Data.steps.every((s) => s.status === "success") &&
              orchCompetitionId
            ) {
              ok(`orchestrate_competition_workflow: ${orch1Data.steps.length} steps completed (competition ${orchCompetitionId})`);
              const orch2 = await callTool(client, "orchestrate_competition_workflow", orchArgs);
              const orch2Data = JSON.parse(orch2.text) as { replayed?: boolean; competitionId?: string };
              if (!orch2.isError && orch2Data.replayed === true && orch2Data.competitionId === orchCompetitionId) {
                ok("orchestrate_competition_workflow: idempotent replay returned the same competitionId (no duplicate)");
              } else {
                bad("orchestrate idempotent replay", orch2.text.slice(0, 300));
              }

              const odetach = await callTool(client, "detach_competition_from_league", {
                actorId: ownerId,
                competitionId: orchCompetitionId,
                idempotencyKey: `smoke-orch-detach-${Date.now()}`,
              });
              const odetachData = JSON.parse(odetach.text) as { ok?: boolean; leagueId?: string | null };
              if (odetachData.ok === true && odetachData.leagueId === null) {
                ok("detach_competition_from_league: orchestrated competition detached (league left untouched)");
              } else {
                bad("orchestrated detach", odetach.text.slice(0, 400));
              }

              const ocancel = await callTool(client, "cancel_competition", {
                actorId: ownerId,
                competitionId: orchCompetitionId,
                idempotencyKey: `smoke-orch-cancel-${Date.now()}`,
              });
              const ocancelData = JSON.parse(ocancel.text) as { ok?: boolean; status?: string };
              if (ocancelData.ok === true && ocancelData.status === "cancelled") {
                ok("cancel_competition: orchestrated fixture cancelled (left cancelled + detached — safe to remove via the app)");
              } else {
                bad("orchestrated cancel", ocancel.text.slice(0, 400));
              }
            } else {
              bad("orchestrate_competition_workflow", orch1.text.slice(0, 400));
            }
          }

          // schedule_competition (handoff to the existing autonomous scheduler)
          const csched = await callTool(client, "schedule_competition", {
            actorId: ownerId,
            competitionId,
            scheduledStartAt: compStart,
            idempotencyKey: `smoke-comp-sched-${Date.now()}`,
          });
          const cschedData = JSON.parse(csched.text) as { ok?: boolean; status?: string; scheduledStartAt?: string };
          if (cschedData.ok === true && cschedData.status === "scheduled" && cschedData.scheduledStartAt === compStart) {
            ok("schedule_competition: status=scheduled (autonomous scheduler handoff configured)");
          } else {
            bad("schedule_competition", csched.text.slice(0, 400));
          }

          // get_competition — verify the tick feed precondition (status='scheduled' + future start).
          // The pg_cron scheduler cannot be driven from the client; this asserts the state it consumes.
          const cget2 = await callTool(client, "get_competition", { actorId: ownerId, competitionId });
          const cget2Data = JSON.parse(cget2.text) as {
            competition?: { status?: string; scheduledStartAt?: string | null };
          };
          const handoffReady =
            cget2Data.competition?.status === "scheduled" &&
            !!cget2Data.competition?.scheduledStartAt &&
            Date.parse(cget2Data.competition.scheduledStartAt) > Date.now();
          if (handoffReady) {
            ok("get_competition: scheduled state satisfies the tick feed precondition (status + future start)");
          } else {
            bad("scheduled handoff verification", cget2.text.slice(0, 400));
          }

          // cancel_competition
          const ccancel = await callTool(client, "cancel_competition", {
            actorId: ownerId,
            competitionId,
            idempotencyKey: `smoke-comp-cancel-${Date.now()}`,
          });
          const ccancelData = JSON.parse(ccancel.text) as { ok?: boolean; status?: string };
          if (ccancelData.ok === true && ccancelData.status === "cancelled") {
            ok("cancel_competition: cancelled");
          } else {
            bad("cancel_competition", ccancel.text.slice(0, 400));
          }

          // get_competition (cancelled)
          const cget3 = await callTool(client, "get_competition", { actorId: ownerId, competitionId });
          const cget3Data = JSON.parse(cget3.text) as {
            competition?: { status?: string; cancelledAt?: string | null };
          };
          if (cget3Data.competition?.status === "cancelled" && cget3Data.competition?.cancelledAt) {
            ok("get_competition: cancelled state verified");
          } else {
            bad("cancelled state verification", cget3.text.slice(0, 400));
          }

          console.log(
            `ℹ Competition smoke fixture left in the database: competition ${competitionId} (cancelled). ` +
              "It is safe to remove via the app.",
          );
        }

        // --- archive_quiz ----------------------------------------------------
        const arcKey = `smoke-archive-${Date.now()}`;
        const arc1 = await callTool(client, "archive_quiz", { actorId: ownerId, quizId, idempotencyKey: arcKey });
        const arc1Data = JSON.parse(arc1.text) as { ok?: boolean; changed?: Record<string, unknown> };
        if (arc1Data.ok === true && arc1Data.changed?.archived === true) {
          ok("archive_quiz: archived");
        } else {
          bad("archive_quiz", arc1.text.slice(0, 400));
        }
        const arc2 = await callTool(client, "archive_quiz", { actorId: ownerId, quizId, idempotencyKey: arcKey });
        const arc2Data = JSON.parse(arc2.text) as { replayed?: boolean };
        if (!arc2.isError && arc2Data.replayed === true) {
          ok("archive_quiz: idempotent replay");
        } else {
          bad("archive_quiz idempotent replay", arc2.text.slice(0, 300));
        }

        // --- verify archived state -------------------------------------------
        const get3 = await callTool(client, "get_quiz", { actorId: ownerId, quizId });
        const get3Data = JSON.parse(get3.text) as { quiz?: { archived?: boolean; archivedAt?: string | null } };
        if (get3Data.quiz?.archived === true && get3Data.quiz?.archivedAt) {
          ok("get_quiz: archived state verified");
        } else {
          bad("archived state verification", get3.text.slice(0, 400));
        }
        const listArc = await callTool(client, "list_quizzes", {
          actorId: ownerId,
          search: "Solar System Smash (Renamed)",
          archived: true,
        });
        const listArcData = JSON.parse(listArc.text) as { items?: Array<{ id: string }> };
        if (listArcData.items?.some((i) => i.id === quizId)) {
          ok("list_quizzes: archived filter finds the archived quiz");
        } else {
          bad("list_quizzes archived filter", listArc.text.slice(0, 400));
        }

        console.log(
          `ℹ Lifecycle smoke fixture left in the database: quiz ${quizId} (archived, renamed). ` +
            "It is safe to remove via the app.",
        );
      }
    }
  }

  // --- generate_quiz (real model when configured) ------------------------
  const hasKey = Boolean(process.env.LLM_API_KEY);
  const isLocalModel = (process.env.LLM_BASE_URL ?? "").includes("localhost");
  if (hasKey || isLocalModel) {
    console.log("→ generate_quiz (real LLM call, may take a moment)…");
    const gen = await callTool(client, "generate_quiz", {
      topic: "Planets of the solar system",
      questionCount: 5,
      difficulty: "easy",
    });
    if (!gen.isError) {
      const genData = JSON.parse(gen.text) as { quiz?: { questions?: unknown[] }; csv?: string };
      if (genData.quiz && genData.csv) {
        ok(`generate_quiz: ${genData.quiz.questions?.length ?? "?"} questions + CSV produced`);
      } else {
        bad("generate_quiz result shape", gen.text.slice(0, 400));
      }
    } else {
      bad("generate_quiz failed", gen.text.slice(0, 400));
    }
  } else {
    console.log(
      "ℹ LLM not configured — skipping generate_quiz (set LLM_BASE_URL/LLM_API_KEY/LLM_MODEL in mcp/.env).",
    );
  }

  await client.close();
  ok("client closed cleanly");

  console.log(
    `\n${failed === 0 ? "ALL TESTS PASSED" : `${failed} TEST(S) FAILED`} (${passed} passed, ${failed} failed)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
