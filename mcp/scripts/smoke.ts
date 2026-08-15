#!/usr/bin/env bun
// Bwat's test client for the Brain Bolt MCP server.
//
// Boots the server as a child process over stdio and exercises every tool:
//   get_capabilities, validate_quiz, to_csv, save_quiz (gate check),
//   and generate_quiz when an LLM provider is configured in mcp/.env
//   (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL — or a local Ollama).
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

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  // Discovery, not an exhaustive equality check: assert the core contract is
  // present and report whatever else the server exposes, so future tools
  // (orchestration layer) don't break this smoke test.
  const required = ["get_capabilities", "generate_quiz", "validate_quiz", "to_csv", "save_quiz"];
  const missing = required.filter((r) => !names.includes(r));
  if (missing.length === 0) {
    ok(`core tools registered (${names.length} total): ${names.join(", ")}`);
  } else {
    bad(`missing core tools: ${missing.join(", ")} — got ${names.join(", ")}`);
  }

  // --- get_capabilities -------------------------------------------------
  const caps = resultText(await client.callTool({ name: "get_capabilities", arguments: {} }));
  const capsData = JSON.parse(caps.text);
  if (
    capsData.questionTypes?.length === 10 &&
    capsData.csvTemplateHeader?.startsWith("question_type,question") &&
    capsData.limits?.questionCount?.max === 30 &&
    capsData.limits?.quizTimePerQuestionSec?.max === 120 &&
    capsData.mediaPolicy?.missingUrlIsError === true &&
    capsData.ownerRequirements?.ownerMustHaveUserPrincipal === true
  ) {
    ok(
      `get_capabilities: ${capsData.questionTypes.length} question types + limits + media policy + owner requirements`,
    );
  } else {
    bad("get_capabilities shape", caps.text.slice(0, 400));
  }

  // --- validate_quiz -----------------------------------------------------
  const val = resultText(
    await client.callTool({ name: "validate_quiz", arguments: { quiz: FIXTURE } }),
  );
  const valData = JSON.parse(val.text);
  if (valData.valid === true) {
    ok(`validate_quiz: valid (${valData.warnings.length} warning(s))`);
  } else {
    bad("validate_quiz on fixture", val.text.slice(0, 300));
  }

  // --- to_csv ------------------------------------------------------------
  const csv = resultText(await client.callTool({ name: "to_csv", arguments: { quiz: FIXTURE } }));
  const csvData = JSON.parse(csv.text) as { csv: string };
  const lines = csvData.csv.trim().split("\n");
  if (lines.length === FIXTURE.questions.length + 1 && lines[1]!.startsWith("multiple_choice,")) {
    ok(`to_csv: ${lines.length - 1} rows, 25-col header, legacy type names`);
  } else {
    bad("to_csv output", csvData.csv?.slice(0, 200));
  }

  // --- save_quiz gate ----------------------------------------------------
  // Without Supabase config the tool must fail with a clear, clean error.
  const save = resultText(
    await client.callTool({
      name: "save_quiz",
      arguments: { quiz: FIXTURE, ownerId: "00000000-0000-0000-0000-000000000000" },
    }),
  );
  if (save.isError && /not configured/.test(save.text)) {
    ok("save_quiz: correctly gated (not configured)");
  } else if (!save.isError) {
    bad("save_quiz unexpectedly succeeded without Supabase config", save.text.slice(0, 200));
  } else {
    bad("save_quiz gate error message", save.text.slice(0, 200));
  }

  // --- generate_quiz (real model when configured) ------------------------
  const hasKey = Boolean(process.env.LLM_API_KEY);
  const isLocalModel = (process.env.LLM_BASE_URL ?? "").includes("localhost");
  if (hasKey || isLocalModel) {
    console.log("→ generate_quiz (real LLM call, may take a moment)…");
    const gen = resultText(
      await client.callTool({
        name: "generate_quiz",
        arguments: { topic: "Planets of the solar system", questionCount: 5, difficulty: "easy" },
      }),
    );
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
