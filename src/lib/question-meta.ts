// Kept as a thin alias so existing imports keep working.
// The single source of truth is `@/lib/question-registry`.
export {
  INTRO_DURATION_MS,
  getQuestionType as getQuestionMetaDef,
} from "./question-registry";
import { getQuestionType, type QuestionTypeDef } from "./question-registry";

export type QuestionMeta = Pick<QuestionTypeDef, "icon" | "name" | "description" | "accent">;

export function getQuestionMeta(type: string): QuestionMeta {
  return getQuestionType(type);
}
