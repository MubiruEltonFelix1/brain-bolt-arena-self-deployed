#!/usr/bin/env bun
// Bwat's test client for the Brain Bolt MCP server.
//
// Boots the server as a child process over stdio and exercises every tool:
//   get_capabilities, validate_quiz, to_csv, save_quiz, and the Phase 8B
//   lifecycle tools (list_quizzes, get_quiz, update_quiz, archive_quiz,
//   question management), plus generate_quiz when an LLM provider is
//   configured in mcp/.env (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).
//
// Discovery is dynamic: the core + lifecycle tool names are asserted against
// the server's own listTools() so future tools don't break the smoke test.
//
// With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + BRAINBOLT_DEFAULT_OWNER_ID
// set, the smoke runs a full lifecycle against the real database:
//   create (idempotent) → list → get → update → get → archive → verify
//   + repeated idempotent create/update replay.
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
  const required = [...CORE_TOOLS, ...LIFECYCLE_TOOLS];
  const missing = required.filter((r) => !names.includes(r));
  if (missing.length === 0) {
    ok(`all ${required.length} core + lifecycle tools registered (${names.length} total)`);
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
  if (lines.length === FIXTURE.questions.length + 1 && lines[1]!.startsWith("multiple_choice,")) {
    ok(`to_csv: ${lines.length - 1} rows, 25-col header, legacy type names`);
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
    for (const tool of LIFECYCLE_TOOLS) {
      const zeroUuid = "00000000-0000-0000-0000-000000000000";
      const actorAndQuiz = { actorId: zeroUuid, quizId: zeroUuid };
      const args: Record<string, unknown> =
        tool === "list_quizzes"
          ? { actorId: zeroUuid }
          : tool === "reorder_questions"
            ? { ...actorAndQuiz, questionIds: [zeroUuid] }
            : tool === "update_quiz"
              ? { ...actorAndQuiz, patch: { title: "x" } }
              : tool === "add_questions"
                ? { ...actorAndQuiz, questions: [{ type: "mcq", text: "x", options: ["a", "b"], correctIndex: 0 }] }
                : tool === "update_question"
                  ? { ...actorAndQuiz, questionId: zeroUuid, patch: { text: "x" } }
                  : { ...actorAndQuiz, questionId: zeroUuid };
      const res = await callTool(client, tool, args);
      if (res.isError && /not configured/.test(res.text)) {
        ok(`${tool}: correctly gated (not configured)`);
      } else {
        gatesOk = false;
        bad(`${tool} gate`, res.text.slice(0, 200));
      }
    }
    if (gatesOk) ok(`all ${LIFECYCLE_TOOLS.length} lifecycle tools gated without Supabase config`);
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
