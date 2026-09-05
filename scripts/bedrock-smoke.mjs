// Smoke test for the Bedrock + DeepSeek R1 integration.
// Loads .env, calls InvokeModelCommand with the same prompt format the
// production provider uses, and prints the raw response so we can verify
// the chat template actually works against us.deepseek.r1-v1:0.
//
// Usage:  bun scripts/bedrock-smoke.mjs

import "dotenv/config";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock/dist-cjs/commands/InvokeModelCommand.js";

const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const modelId = process.env.BRAINBOLT_AI_MODEL ?? "us.deepseek.r1-v1:0";

if (!region || !accessKeyId || !secretAccessKey) {
  console.error(
    "Missing AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env",
  );
  process.exit(1);
}

console.log(`[smoke] region=${region}  modelId=${modelId}`);
console.log(`[smoke] accessKeyId=${accessKeyId.slice(0, 8)}...`);

const client = new BedrockClient({ region });

// This is the EXACT prompt format the production provider renders in
// src/lib/ai/providers/bedrock-deepseek.server.ts. If this fails, the
// production provider fails too.
const system = `You are a quiz question generator. Output ONLY valid JSON in the form {"questions": [...]}. No commentary, no markdown fences.`;
const user = `Topic: Photosynthesis
Number of questions: 1
Difficulty: easy
Question types allowed: mcq

Output a single multiple-choice question about photosynthesis.`;

const renderedPrompt = `${system}\n\nHuman: ${user}\n\nAssistant:`;

const body = {
  prompt: renderedPrompt,
  max_tokens: 1024,
  temperature: 0.4,
  top_p: 0.9,
};

const command = new InvokeModelCommand({
  modelId,
  contentType: "application/json",
  accept: "application/json",
  body: JSON.stringify(body),
});

const start = Date.now();
try {
  const response = await client.send(command);
  const elapsed = Date.now() - start;
  const text =
    response.body instanceof Uint8Array
      ? new TextDecoder().decode(response.body)
      : typeof response.body === "string"
        ? response.body
        : "";
  console.log(`\n[smoke] response received in ${elapsed}ms`);
  console.log(`[smoke] raw text (first 800 chars):\n---\n${text.slice(0, 800)}\n---`);
  console.log(`[smoke] raw text length: ${text.length} chars`);
  // Check for a JSON object in the response.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      console.log(`\n[smoke] JSON parsed successfully. Keys: ${Object.keys(parsed).join(", ")}`);
      if (parsed.questions && Array.isArray(parsed.questions)) {
        console.log(`[smoke] questions.length = ${parsed.questions.length}`);
        console.log(`[smoke] first question type = ${parsed.questions[0]?.type}`);
        console.log(`\n[smoke] ✅ CHAT TEMPLATE WORKS — production provider should succeed.`);
      } else {
        console.log(`\n[smoke] ⚠️  JSON parsed but no "questions" array. Production provider would return invalid_output.`);
        console.log(`[smoke] parsed: ${JSON.stringify(parsed).slice(0, 400)}`);
      }
    } catch (e) {
      console.log(`\n[smoke] ⚠️  JSON extract failed to parse: ${e.message}`);
      console.log(`[smoke] extracted candidate (first 400 chars):\n${candidate.slice(0, 400)}`);
    }
  } else {
    console.log(`\n[smoke] ⚠️  No JSON object found in response.`);
    console.log(`[smoke] Production provider would return invalid_output.`);
  }
} catch (e) {
  const elapsed = Date.now() - start;
  console.error(`\n[smoke] ❌ Bedrock call FAILED after ${elapsed}ms`);
  console.error(`[smoke] name: ${e?.name}`);
  console.error(`[smoke] message: ${e?.message}`);
  if (e.$metadata) {
    console.error(
      `[smoke] httpStatusCode: ${e.$metadata.httpStatusCode}  requestId: ${e.$metadata.requestId}`,
    );
  }
  if (e.name === "AccessDeniedException") {
    console.error(
      `\n[smoke] → Access denied. The IAM user lacks InvokeModel permission, or the model isn't enabled in ${region}.`,
    );
  } else if (e.name === "ValidationException" && /model/i.test(e?.message ?? "")) {
    console.error(
      `\n[smoke] → Model not found. The inference profile ${modelId} is not enabled in ${region}. Enable it under Bedrock → Model access.`,
    );
  } else if (e.name === "CredentialsProviderError" || e.name === "CredentialsError") {
    console.error(
      `\n[smoke] → Credentials invalid. Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.`,
    );
  }
  process.exit(1);
}
