// Environment configuration. Read once at process start — this is a plain
// bun/Node process (not a Cloudflare Worker), so module-scope env reads are
// fine here, unlike the app's rules for `process.env`.

import type { LlmConfig } from "./llm";

export type AppConfig = {
  /** null until LLM_BASE_URL + LLM_MODEL are set — generate_quiz stays disabled. */
  llm: LlmConfig | null;
  /** null when save_quiz is not configured (JSON/CSV output still works). */
  supabase: { url: string; serviceRoleKey: string } | null;
  defaultOwnerId: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  const llm: LlmConfig | null =
    baseUrl && model ? { baseUrl, apiKey: env.LLM_API_KEY?.trim() ?? "", model } : null;

  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const supabase = supabaseUrl && serviceRoleKey ? { url: supabaseUrl, serviceRoleKey } : null;

  const defaultOwnerId = env.BRAINBOLT_DEFAULT_OWNER_ID?.trim() || null;

  return { llm, supabase, defaultOwnerId };
}
