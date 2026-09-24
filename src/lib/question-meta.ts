// Kept as a thin alias so existing imports keep working.
//
// Wording lives in `@/lib/question-presentation`; behaviour and grading
// helpers live in `@/lib/question-registry`.
export {
  INTRO_DURATION_MS,
  getQuestionType as getQuestionMetaDef,
} from "./question-registry";
import { getQuestionType, type QuestionTypeDef } from "./question-registry";

export type QuestionMeta = Pick<
  QuestionTypeDef,
  "icon" | "label" | "tagline" | "description" | "accent"
>;

export function getQuestionMeta(type: string): QuestionMeta {
  return getQuestionType(type);
}
