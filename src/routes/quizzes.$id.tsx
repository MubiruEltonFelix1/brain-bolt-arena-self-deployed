import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { EmptyState } from "@/components/EmptyState";
import { useAuthUser } from "@/hooks/use-auth-user";
import { MapPicker } from "@/components/MapPicker";
import { AiQuestionBuilderPanel } from "@/components/quiz/AiQuestionBuilderPanel";
import type { GeoRegion } from "@/lib/question-registry";
import {
  questionTypeHelpText,
  questionTypeLabel,
  questionTypeListLabel,
  questionTypeOptions,
} from "@/lib/question-presentation";
import type { CountryRegion } from "@/lib/geo/country-regions";
import {
  toastError,
  safeErrorMessage,
  resourceNotFoundMessage,
  logActionError,
} from "@/lib/errors";
import { toast } from "sonner";
import { ArrowUp } from "lucide-react";
import {
  SECTION_TITLE_MAX,
  type QuizSection,
  type QuestionFlow,
  type SectionValidation,
  groupQuestions,
  isQuestionFlow,
  nextSectionPosition,
  normalizeSectionTitle,
  sectionTitleKey,
  sortSections,
  validateQuizSections,
} from "@/lib/quiz/sections";

export const Route = createFileRoute("/quizzes/$id")({
  component: QuizEditor,
});

type Quiz = {
  id: string;
  title: string;
  description: string | null;
  time_per_question: number;
  owner_principal_id: string;
  /**
   * Authoring layout. Absent on responses from a database that predates the
   * Phase 12 migration, so every read is normalised through `isQuestionFlow`
   * and treated as `"flat"` when unrecognised.
   */
  question_flow?: QuestionFlow;
};
type QuestionType =
  | "mcq"
  | "true_false"
  | "image_mcq"
  | "map_pin"
  | "number"
  | "type"
  | "feedback"
  | "image_reveal"
  | "audio"
  | "ordering";
type Question = {
  id: string;
  text: string;
  options: string[];
  correct_index: number;
  position: number;
  time_limit_sec: number | null;
  point_value: number;
  question_type: QuestionType;
  image_url: string | null;
  double_points: boolean;
  is_playable: boolean;
  correct_lat: number | null;
  correct_lng: number | null;
  max_distance_km: number | null;
  correct_number: number | null;
  number_min: number | null;
  number_max: number | null;
  number_tolerance: number | null;
  accepted_answers: string[] | null;
  reveal_stages?: number | null;
  audio_url?: string | null;
  geo_region?: GeoRegion | null;
  geo_region_label?: string | null;
  /** Owning section for categorized quizzes; null = ungrouped. */
  section_id?: string | null;
};

// Delete an image/audio upload that is no longer referenced by any question
// row. The object path is recovered from the signed or public URL we saved;
// external URLs (CSV imports) are left untouched. Fire-and-forget: failures
// are logged, not toasted — the question row is already updated, so the
// worst case is an orphan that has to be removed by hand.
function removeOrphanedUpload(url: string | null | undefined) {
  if (!url) return;
  let path: string | null = null;
  try {
    const match = new URL(url).pathname.match(
      /\/storage\/v1\/object\/(?:sign|public)\/quiz-images\/(.+)$/,
    );
    path = match ? decodeURIComponent(match[1]) : null;
  } catch {
    return;
  }
  if (!path) return;
  supabase.storage
    .from("quiz-images")
    .remove([path])
    .then(({ error }) => {
      if (error)
        console.warn(`Could not remove orphaned upload "${path}" from storage:`, error.message);
    })
    .catch((err) => console.warn(`Could not remove orphaned upload "${path}" from storage:`, err));
}

// Universal BrainBolt CSV template. Every column is optional except
// `question_type` and `question`; the importer ignores columns that do not
// apply to a given row's type. Old templates (question,option_a..d,correct,
// time,points) continue to import unchanged.
const CSV_TEMPLATE = `question_type,question,option_a,option_b,option_c,option_d,correct_answer,explanation,time_limit,points,image_url,audio_url,map_latitude,map_longitude,map_zoom,numeric_answer,tolerance,answer_format,slider_min,slider_max,accepted_answers,reveal_duration,order_items,match_pairs,double_points,region,section
multiple_choice,What is 2 + 2?,1,2,3,4,D,Basic arithmetic,20,1000,,,,,,,,,,,,,,,false,
true_false,The sky is blue on a clear day.,,,,,TRUE,,15,1000,,,,,,,,,,,,,,,false,
multiple_choice,Largest planet in our solar system?,Earth,Mars,Jupiter,Venus,Jupiter,Gas giant,25,2000,,,,,,,,,,,,,,,true,
text,Which fruit keeps the doctor away?,,,,,,Common English proverb,20,1000,,,,,,,,,,,apple;an apple;apples,,,,false,
free_text,What did you enjoy most about today?,,,,,,Open feedback question,30,0,,,,,,,,,,,,,,,false,
closest_number,In what year did the Berlin Wall fall?,,,,,,Historical event,25,1000,,,,,,1989,2,year,1950,2000,,,,,false,
map_pin,Locate Paris on the map,,,,,,Capital of France,30,1000,,,48.8566,2.3522,4,,3000,,,,,,,,false,
image_reveal,Guess the landmark as the image reveals,Eiffel Tower,Big Ben,Colosseum,Statue of Liberty,Eiffel Tower,,30,1500,https://example.com/landmark.jpg,,,,,,,,,,,5,,,false,
audio,Name this song,Song A,Song B,Song C,Song D,Song B,,25,1000,,https://example.com/clip.mp3,,,,,,,,,,,,,false,
ordering,Put these events in chronological order,,,,,,Earliest to latest,45,1500,,,,,,,,,,,,,Wake up;Eat breakfast;Go to school;Study,,false,
matching,Match each country to its capital,,,,,,Not yet supported in gameplay,30,1000,,,,,,,,,,,,,,France=Paris;Japan=Tokyo;Kenya=Nairobi,false,
`;

const CSV_README = `BrainBolt CSV Template - Column Reference
=========================================

Required columns
----------------
question_type   One of: multiple_choice, true_false, text, free_text,
                closest_number, map_pin, image_reveal, audio, ordering,
                matching. Aliases accepted (mcq, tf, number, geo, etc).
                These short tokens are the file format's own vocabulary —
                see "What each question type does" below for plain English.
question        The prompt shown to players.

What each question type does
----------------------------
multiple_choice   ${questionTypeHelpText("mcq")}
true_false        ${questionTypeHelpText("true_false")}
closest_number    ${questionTypeHelpText("number")}
text              ${questionTypeHelpText("type")}
free_text         ${questionTypeHelpText("feedback")}
map_pin           ${questionTypeHelpText("map_pin")}
image_reveal      ${questionTypeHelpText("image_reveal")}
audio             ${questionTypeHelpText("audio")}
ordering          ${questionTypeHelpText("ordering")}

Common optional columns
-----------------------
time_limit      Seconds allowed (5-300). Alias: time_limit_sec, time.
points          Points awarded (1-100000). Alias: point_value.
explanation     Free text shown as context. Currently stored only in CSV;
                ignored by gameplay.
double_points   true/false. Doubles score for the round.
image_url       Optional cover image for the question.
section         Optional. Categorized quizzes only — the section this question
                belongs to. Rows with the same section name (case and
                whitespace insensitive) join the same section; a name that
                does not exist yet is created. On a STANDARD quiz this column
                is ignored, never applied — switch the quiz to Categorized
                first. See "Sections" below.

Type-specific columns
---------------------
multiple_choice   option_a..option_d, correct_answer (A-D, 1-4, or option
                  text).
true_false        correct_answer = TRUE or FALSE.
text              accepted_answers, semicolon-separated (e.g.
                  "apple;Apple Inc.;apples").
free_text         No correct answer; used for feedback / open opinion.
closest_number    numeric_answer (required), tolerance, slider_min,
                  slider_max, answer_format (general | year | decimal |
                  percentage | currency).
map_pin           map_latitude, map_longitude, tolerance (km radius,
                  defaults to 5000). region accepts a country name from the
                  bundled dataset (e.g. "Kenya") — with a region, any click
                  inside it scores full marks and tolerance becomes the
                  falloff band beyond the border (defaults to 300). The
                  centroid is filled automatically from the region; latitude
                  and longitude then become optional. map_zoom is accepted
                  but currently ignored by gameplay.
image_reveal      option_a..option_d + correct_answer, image_url,
                  reveal_duration (stages, defaults to 5).
audio             option_a..option_d + correct_answer, audio_url.
ordering          order_items, semicolon-separated in correct order
                  (e.g. "Wake up;Eat breakfast;Go to school").
matching          match_pairs, formatted "Key=Value;Key=Value". Not yet
                  supported in gameplay - rows will be skipped.

Backward compatibility
----------------------
Files that only include: question, option_a..d, correct_answer, time,
points still import exactly as before. Unknown columns are ignored, and a file
without a section column imports exactly as before.

Sections
--------
A quiz is either a STANDARD quiz (questions play in one continuous order) or a
CATEGORIZED quiz (questions are grouped into named, ordered sections). The
section column is only meaningful for categorized quizzes:

  * The column is optional. A file with no section column imports fine.
  * Section names are compared after trimming and collapsing repeated spaces,
    and case-insensitively — "Round  1", " round 1 " and "ROUND 1" are all the
    same section.
  * Two sections with the same name are allowed in the editor, but a CSV can
    only ever address the first one. Keep names distinct in files.
  * A section name that does not exist on the quiz yet is created, appended
    after the existing sections.
  * Importing NEVER switches a quiz into categorized mode. If the quiz is
    standard, the section column is ignored and a note is shown.
`;

function QuizEditor() {
  const { id } = Route.useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  // Authoring-side sections. Empty for every pre-Phase-12 flat quiz, which is
  // why nothing below this line is reachable until the owner opts in.
  const [sections, setSections] = useState<QuizSection[]>([]);
  const [sectionsError, setSectionsError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Guards against a stale in-flight load (e.g. a failure-path reload for the
  // previous quiz id) overwriting newer state after navigation.
  const loadSeq = useRef(0);

  async function load() {
    const seq = ++loadSeq.current;
    setMissing(false);
    setLoadError(null);
    const { data: q, error } = await supabase
      .from("quizzes")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (seq !== loadSeq.current) return; // superseded by a newer load
    if (error) {
      setLoadError(error);
      return;
    }
    if (!q) {
      setMissing(true);
      return;
    }
    setQuiz(q as Quiz);
    const { data: qs } = await supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", id)
      .order("position");
    if (seq !== loadSeq.current) return;
    setQuestions((qs as Question[] | null) ?? []);
    // Sections load in the same pass so a categorized quiz never renders with
    // an empty section list and momentarily looks like all its questions lost
    // their grouping. Ordered by the same tiebreakers the shared helper uses
    // (position, created_at, id) — see src/lib/quiz/sections.ts.
    const { data: sec, error: secErr } = await supabase
      .from("quiz_sections")
      .select("id,quiz_id,title,position,created_at")
      .eq("quiz_id", id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (seq !== loadSeq.current) return;
    if (secErr) {
      // Tolerated rather than fatal: the rest of the editor is fully usable on
      // a database where the Phase 12 migration has not been applied yet.
      setSectionsError(secErr);
      setSections([]);
    } else {
      setSectionsError(null);
      setSections((sec as QuizSection[] | null) ?? []);
    }
  }
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, [id]);

  if (loadError) {
    return (
      <HostShell>
        <div className="max-w-3xl mx-auto px-6 py-10 space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">
            Quiz unavailable
          </p>
          <p className="text-foreground/70">{safeErrorMessage(loadError)}</p>
          <button
            onClick={load}
            className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta active:scale-95"
          >
            TRY AGAIN
          </button>
        </div>
      </HostShell>
    );
  }
  if (missing) {
    return (
      <HostShell>
        <div className="max-w-3xl mx-auto px-6 py-10 space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">
            Quiz unavailable
          </p>
          <p className="text-foreground/70">{resourceNotFoundMessage("quiz")}</p>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={load}
              className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta active:scale-95"
            >
              TRY AGAIN
            </button>
            <Link
              to="/dashboard"
              className="inline-block border border-border px-4 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </HostShell>
    );
  }
  if (!quiz)
    return (
      <HostShell>
        <div className="p-12 font-mono text-sm text-foreground/40">LOADING...</div>
      </HostShell>
    );
  if (user && quiz.owner_principal_id !== user.id) {
    return (
      <HostShell>
        <div className="max-w-3xl mx-auto px-6 py-10 space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">Quiz locked</p>
          <p className="text-foreground/70">You don't have permission to edit this quiz.</p>
          <Link
            to="/dashboard"
            className="inline-block border border-border px-4 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </HostShell>
    );
  }

  async function saveQuiz(patch: Partial<Quiz>) {
    setSaving(true);
    const { error } = await supabase.from("quizzes").update(patch).eq("id", id);
    setSaving(false);
    if (error) return toastError(error, { context: "save quiz" });
    setQuiz({ ...quiz!, ...patch });
  }

  async function addQuestion() {
    const position = questions.length;
    const { data, error } = await supabase
      .from("questions")
      .insert({
        quiz_id: id,
        text: "New question",
        options: ["Option A", "Option B", "Option C", "Option D"],
        correct_index: 0,
        position,
        point_value: 1000,
        question_type: "mcq",
        image_url: null,
        double_points: false,
        max_distance_km: 5000,
      })
      .select("*")
      .single();
    if (error || !data)
      return toastError(error, {
        context: "add question",
        fallback: "Could not add the question.",
      });
    setQuestions([...questions, data as Question]);
  }

  async function updateQuestion(qid: string, patch: Partial<Question>) {
    const previous = questions.find((q) => q.id === qid);
    setQuestions((prev) => prev.map((q) => (q.id === qid ? { ...q, ...patch } : q)));
    const { error } = await supabase
      .from("questions")
      .update(patch as any)
      .eq("id", qid);
    if (error) {
      toastError(error, { context: "update question" });
      return;
    }
    // Drop the storage object for an image/audio that lost its reference.
    // Only when the value actually changed — blurSave resends the whole row.
    if (previous) {
      if (patch.image_url !== undefined && patch.image_url !== previous.image_url)
        removeOrphanedUpload(previous.image_url);
      if (patch.audio_url !== undefined && patch.audio_url !== previous.audio_url)
        removeOrphanedUpload(previous.audio_url);
    }
  }

  async function deleteQuestion(qid: string) {
    const next = questions.filter((q) => q.id !== qid).map((q, i) => ({ ...q, position: i }));
    setQuestions(next);
    const { error } = await supabase.from("questions").delete().eq("id", qid);
    if (error) {
      toastError(error, { context: "delete question" });
      load();
      return;
    }
    // re-persist positions
    const results = await Promise.all(
      next.map((q) => supabase.from("questions").update({ position: q.position }).eq("id", q.id)),
    );
    const failed = results.find((r) => r.error);
    if (failed) {
      toastError(failed.error, { context: "reposition questions after delete" });
      load();
    }
  }

  async function moveQuestion(qid: string, dir: -1 | 1) {
    const idx = questions.findIndex((q) => q.id === qid);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= questions.length) return;
    const next = [...questions];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    const reposed = next.map((q, i) => ({ ...q, position: i }));
    setQuestions(reposed);
    const results = await Promise.all([
      supabase.from("questions").update({ position: idx }).eq("id", next[idx].id),
      supabase.from("questions").update({ position: swap }).eq("id", next[swap].id),
    ]);
    const failed = results.find((r) => r.error);
    if (failed) {
      toastError(failed.error, { context: "reorder questions" });
      load();
    }
  }

  async function setAllPlayable(playable: boolean) {
    const ids = questions.map((q) => q.id);
    if (ids.length === 0) return;
    // Roll back only the flag on failure — a whole-snapshot restore would also
    // revert content edits committed by other cards in the meantime.
    const previousFlag = new Map(questions.map((q) => [q.id, q.is_playable]));
    setQuestions((prev) => prev.map((q) => ({ ...q, is_playable: playable })));
    const { error } = await supabase
      .from("questions")
      .update({ is_playable: playable })
      .in("id", ids);
    if (error) {
      toastError(error, { context: playable ? "enable all questions" : "exclude all questions" });
      setQuestions((prev) =>
        prev.map((q) => ({ ...q, is_playable: previousFlag.get(q.id) ?? q.is_playable })),
      );
    }
  }

  // ---- Quiz flow + sections (Phase 12) ----
  //
  // A quiz is `flat` (the historical layout: one continuous question order) or
  // `categorized` (questions are grouped into named, ordered sections). An
  // unrecognised / absent value reads as `flat`, so a database that predates
  // the Phase 12 migration behaves exactly as it always did.
  const flow: QuestionFlow = isQuestionFlow(quiz.question_flow) ? quiz.question_flow : "flat";
  const categorized = flow === "categorized";
  const orderedSections = sortSections(sections);

  async function setFlow(next: QuestionFlow) {
    if (next === flow) return;
    setSaving(true);
    const { error } = await supabase.from("quizzes").update({ question_flow: next }).eq("id", id);
    setSaving(false);
    if (error) return toastError(error, { context: "change quiz flow" });
    setQuiz({ ...quiz!, question_flow: next });
    toast.success(
      next === "categorized"
        ? "Categorized quiz — group your questions into sections below."
        : "Standard quiz — questions play in one continuous order. Your sections are kept and hidden.",
    );
  }

  async function addSection() {
    const used = new Set(sections.map((s) => sectionTitleKey(s.title)));
    // Pick the first free "Section N" so a repeated click never creates two
    // identically named sections, which a CSV `section` column could not
    // address unambiguously.
    let n = sections.length + 1;
    let title = `Section ${n}`;
    while (used.has(sectionTitleKey(title))) {
      n += 1;
      title = `Section ${n}`;
    }
    const { data, error } = await supabase
      .from("quiz_sections")
      .insert({ quiz_id: id, title, position: nextSectionPosition(sections) })
      .select("id,quiz_id,title,position,created_at")
      .single();
    if (error || !data)
      return toastError(error, {
        context: "add section",
        fallback: "Could not add the section.",
      });
    setSections((prev) => [...prev, data as QuizSection]);
  }

  /** Returns false when the name was rejected so the input can revert. */
  async function renameSection(sectionId: string, rawTitle: string): Promise<boolean> {
    const current = sections.find((s) => s.id === sectionId);
    if (!current) return false;
    const title = normalizeSectionTitle(rawTitle);
    if (!title) {
      toast.error("Section names cannot be empty.");
      return false;
    }
    if (title === normalizeSectionTitle(current.title)) return true;
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, title } : s)));
    const { error } = await supabase.from("quiz_sections").update({ title }).eq("id", sectionId);
    if (error) {
      toastError(error, { context: "rename section" });
      setSections((prev) =>
        prev.map((s) => (s.id === sectionId ? { ...s, title: current.title } : s)),
      );
      return false;
    }
    return true;
  }

  async function moveSection(sectionId: string, dir: -1 | 1) {
    const list = sortSections(sections);
    const idx = list.findIndex((s) => s.id === sectionId);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    const next = [...list];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    // Re-rank the WHOLE list 0..n-1 rather than swapping two values. That heals
    // any duplicate or gapped ranks left behind by an earlier client, and keeps
    // the order deterministic (position, then created_at, then id).
    const reranked = next.map((s, i) => ({ ...s, position: i }));
    setSections(reranked);
    const changed = reranked.filter((s) => list.find((o) => o.id === s.id)?.position !== s.position);
    const results = await Promise.all(
      changed.map((s) =>
        supabase.from("quiz_sections").update({ position: s.position }).eq("id", s.id),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed) {
      toastError(failed.error, { context: "reorder sections" });
      load();
    }
  }

  async function deleteSection(sectionId: string) {
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return;
    const label = normalizeSectionTitle(section.title) || "this section";
    // The questions are NEVER deleted. The database's ON DELETE SET NULL clears
    // their section_id; this confirmation exists so the owner learns how many
    // questions become ungrouped before it happens, and what that costs.
    const affected = questions.filter((q) => q.section_id === sectionId);
    const playableAffected = affected.filter((q) => q.is_playable !== false);
    if (affected.length === 0) {
      if (!confirm(`Delete the empty section "${label}"?`)) return;
    } else {
      const questionNote = `${affected.length} question${affected.length === 1 ? "" : "s"} will become ungrouped — they are NOT deleted.`;
      const playNote =
        playableAffected.length > 0
          ? `\n\n${playableAffected.length} of them ${playableAffected.length === 1 ? "is" : "are"} included in play, so this quiz will need repair before it can be started.`
          : "";
      if (!confirm(`Delete the section "${label}"?\n\n${questionNote}${playNote}`)) return;
    }
    setQuestions((prev) =>
      prev.map((q) => (q.section_id === sectionId ? { ...q, section_id: null } : q)),
    );
    const { error } = await supabase.from("quiz_sections").delete().eq("id", sectionId);
    if (error) {
      toastError(error, { context: "delete section" });
      load();
      return;
    }
    setSections((prev) => prev.filter((s) => s.id !== sectionId));
    toast.success("Section deleted — its questions were kept.");
  }

  function assignQuestionToSection(qid: string, sectionId: string | null) {
    // Section membership has its own writer. QuestionEditor.blurSave strips
    // `section_id` for exactly the reason it strips `position` and
    // `is_playable`: the blur fired by choosing this dropdown must not race the
    // assignment and restore the previous section.
    return updateQuestion(qid, { section_id: sectionId });
  }

  // Recomputed on every render; the rule set lives in src/lib/quiz/sections.ts
  // so the pre-start gate in the dashboard applies byte-identical rules.
  const sectionValidation = validateQuizSections({ flow, sections, questions });

  // ---- CSV import ----
  function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ",") {
          out.push(cur);
          cur = "";
        } else cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function resolveCorrect(raw: string, opts: string[]): number {
    const v = raw.trim();
    if (!v) return -1;
    // numeric: support 0-based or 1-based
    if (/^\d+$/.test(v)) {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= opts.length) return n - 1; // 1-based, as used by most CSV/question banks
      if (n === 0) return 0; // still accept explicit 0-based A
      return -1;
    }
    // single letter A-F
    if (/^[A-Fa-f]$/.test(v)) {
      const n = v.toUpperCase().charCodeAt(0) - 65;
      return n < opts.length ? n : -1;
    }
    // match option text
    const lower = v.toLowerCase();
    const idx = opts.findIndex((o) => o.trim().toLowerCase() === lower);
    return idx;
  }

  async function importCsv(text: string) {
    setCsvErrors([]);
    const rows = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (rows.length === 0) return toast.error("Empty CSV file");

    const normalizeHeader = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[\s-]+/g, "_")
        .replace(/[^\w]/g, "");
    const first = parseCsvLine(rows[0]).map(normalizeHeader);
    const hasHeader =
      first.some((c) => /^(question|q|prompt)$/.test(c)) ||
      first.includes("correct") ||
      first.includes("correct_answer") ||
      first.includes("answer");
    let header: string[] = [];
    let dataRows = rows;
    if (hasHeader) {
      header = first;
      dataRows = rows.slice(1);
    }

    const errors: string[] = [];
    // Lazily load the country dataset only when a `region` column is present.
    const regionLookup = header.includes("region")
      ? (await import("@/lib/geo/country-regions")).findCountryRegion
      : null;
    type InsertRow = {
      text: string;
      options: string[];
      correct_index: number;
      time_limit_sec: number | null;
      point_value: number;
      question_type: QuestionType;
      image_url: string | null;
      double_points: boolean;
      correct_lat: number | null;
      correct_lng: number | null;
      max_distance_km: number | null;
      correct_number: number | null;
      number_min: number | null;
      number_max: number | null;
      number_tolerance: number | null;
      accepted_answers: string[] | null;
      audio_url: string | null;
      reveal_stages: number | null;
      geo_region?: GeoRegion | null;
      geo_region_label?: string | null;
    };
    const toInsert: InsertRow[] = [];
    // Parallel array: the raw `section` cell for toInsert[i], or "" when the
    // row had none. Kept separate from InsertRow so the row shape that reaches
    // the insert statement stays exactly what it was before Phase 12.
    const sectionByRow: string[] = [];
    const hasSectionColumn = header.includes("section") || header.includes("section_name");

    dataRows.forEach((line, ri) => {
      const lineNo = ri + (hasHeader ? 2 : 1);
      const parts = parseCsvLine(line);
      let qtext = "";
      let opts: string[] = [];
      let correctRaw = "";
      let timeRaw = "";
      let pointsRaw = "";
      let typeRaw = "";
      let imageRaw = "";
      let dblRaw = "";
      let latRaw = "",
        lngRaw = "",
        maxDistRaw = "",
        regionRaw = "";
      let numRaw = "",
        numMinRaw = "",
        numMaxRaw = "",
        numTolRaw = "";
      let audioRaw = "",
        acceptedRaw = "",
        orderRaw = "",
        matchRaw = "";
      let revealRaw = "",
        answerFormatRaw = "";
      // Optional categorize column (Phase 12). Only honoured when the quiz is
      // already in categorized mode — see the resolution pass after the loop.
      let sectionRaw = "";
      // Index of the first row this callback may append, so a rejected row
      // never records a section title for the row that follows it.
      const firstFreeRow = toInsert.length;

      if (header.length) {
        const get = (name: string) => {
          const i = header.indexOf(name);
          return i >= 0 ? (parts[i] ?? "") : "";
        };
        qtext = get("question") || get("q") || get("prompt");
        const optNames = ["option_a", "option_b", "option_c", "option_d", "option_e", "option_f"];
        opts = optNames.map(get).filter((v) => v !== "");
        if (opts.length < 2) {
          const altNames = ["opt1", "opt2", "opt3", "opt4", "opt5", "opt6"];
          const alt = altNames.map(get).filter((v) => v !== "");
          if (alt.length >= 2) opts = alt;
        }
        correctRaw =
          get("correct_answer") || get("correct") || get("answer") || get("correct_index");
        timeRaw = get("time_limit") || get("time_limit_sec") || get("time") || get("seconds");
        pointsRaw = get("points") || get("point_value");
        typeRaw = get("question_type") || get("type");
        imageRaw = get("image_url") || get("image");
        dblRaw = get("double_points") || get("double");
        latRaw = get("map_latitude") || get("correct_lat") || get("lat") || get("latitude");
        lngRaw =
          get("map_longitude") ||
          get("correct_lng") ||
          get("lng") ||
          get("lon") ||
          get("long") ||
          get("longitude");
        // For map_pin `tolerance` = km radius; for number it's numeric tolerance.
        const genericTol = get("tolerance");
        maxDistRaw = get("max_distance_km") || get("max_km") || "";
        regionRaw = get("region") || get("country") || "";
        numRaw = get("numeric_answer") || get("correct_number") || get("number") || get("value");
        numMinRaw = get("slider_min") || get("number_min") || get("min");
        numMaxRaw = get("slider_max") || get("number_max") || get("max");
        numTolRaw = get("number_tolerance") || genericTol;
        if (!maxDistRaw && genericTol) maxDistRaw = genericTol;
        audioRaw = get("audio_url") || get("audio");
        acceptedRaw = get("accepted_answers") || get("answers");
        orderRaw = get("order_items") || get("ordering") || get("order");
        matchRaw = get("match_pairs") || get("matches") || get("pairs");
        revealRaw = get("reveal_duration") || get("reveal_stages") || get("stages");
        answerFormatRaw = get("answer_format") || get("format");
        sectionRaw = get("section") || get("section_name");
      } else {
        if (parts.length < 4) {
          errors.push(`Row ${lineNo}: needs at least question + 2 options + correct`);
          return;
        }
        qtext = parts[0];
        const tail = parts.slice(-3);
        const allInt = (s: string) => /^\d+$/.test(s);
        if (parts.length >= 6 && allInt(tail[1]) && allInt(tail[2])) {
          correctRaw = tail[0];
          timeRaw = tail[1];
          pointsRaw = tail[2];
          opts = parts.slice(1, parts.length - 3);
        } else {
          correctRaw = parts[parts.length - 1];
          opts = parts.slice(1, parts.length - 1);
        }
      }

      qtext = qtext?.trim() ?? "";
      const qtype: QuestionType | "matching" = (() => {
        const t = typeRaw.toLowerCase().trim();
        if (t === "true_false" || t === "truefalse" || t === "tf" || t === "boolean")
          return "true_false";
        if (t === "image_mcq") return "image_mcq";
        if (t === "map_pin" || t === "map" || t === "geo") return "map_pin";
        if (
          t === "number" ||
          t === "numeric" ||
          t === "slider" ||
          t === "closest_number" ||
          t === "closest"
        )
          return "number";
        if (t === "text" || t === "type" || t === "short_answer") return "type";
        if (t === "feedback" || t === "free_text" || t === "opinion" || t === "open")
          return "feedback";
        if (t === "image_reveal" || t === "reveal" || t === "image") return "image_reveal";
        if (t === "audio" || t === "sound") return "audio";
        if (t === "ordering" || t === "order" || t === "sequence") return "ordering";
        if (t === "matching" || t === "match" || t === "pairs") return "matching";
        return "mcq";
      })();

      if (qtype === "matching") {
        errors.push(
          `Row ${lineNo}: "Match the Pairs" questions cannot be played yet — use another type for now`,
        );
        return;
      }

      const base = {
        image_url: imageRaw.trim() || null,
        double_points: /^(1|true|yes|y)$/i.test(dblRaw.trim()),
      };
      const emptyExtras = {
        correct_lat: null as number | null,
        correct_lng: null as number | null,
        max_distance_km: null as number | null,
        correct_number: null as number | null,
        number_min: null as number | null,
        number_max: null as number | null,
        number_tolerance: null as number | null,
        accepted_answers: null as string[] | null,
        audio_url: audioRaw.trim() || null,
        reveal_stages: null as number | null,
      };

      if (qtype === "map_pin") {
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        // Optional `region` column: a country name/key from the bundled
        // dataset. When present, any click inside the region scores full marks
        // and the tolerance becomes the falloff band beyond the border.
        let regionEntry: CountryRegion | null = null;
        const regionName = regionRaw.trim();
        if (regionName) {
          regionEntry = regionLookup ? regionLookup(regionName) : null;
          if (!regionEntry) {
            errors.push(`Row ${lineNo}: unknown region "${regionName}"`);
            return;
          }
        }
        const lat = parseFloat(latRaw),
          lng = parseFloat(lngRaw);
        const hasCoords = isFinite(lat) && isFinite(lng);
        if (!regionEntry && !hasCoords) {
          errors.push(`Row ${lineNo}: map_pin needs map_latitude/map_longitude (or a region)`);
          return;
        }
        if (hasCoords && (lat < -90 || lat > 90)) {
          errors.push(`Row ${lineNo}: map_pin needs map_latitude (-90..90)`);
          return;
        }
        if (hasCoords && (lng < -180 || lng > 180)) {
          errors.push(`Row ${lineNo}: map_pin needs map_longitude (-180..180)`);
          return;
        }
        const kmDefault = regionEntry ? 300 : 5000;
        const maxKm = maxDistRaw ? parseFloat(maxDistRaw) : kmDefault;
        toInsert.push({
          text: qtext,
          options: [],
          correct_index: -1,
          time_limit_sec: null,
          point_value: 1000,
          question_type: "map_pin",
          ...base,
          ...emptyExtras,
          correct_lat: regionEntry ? regionEntry.label.lat : lat,
          correct_lng: regionEntry ? regionEntry.label.lng : lng,
          max_distance_km: isFinite(maxKm) ? maxKm : kmDefault,
          geo_region: regionEntry ? regionEntry.region : null,
          geo_region_label: regionEntry ? regionEntry.name : null,
        });
      } else if (qtype === "number") {
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        const n = parseFloat(numRaw);
        if (!isFinite(n)) {
          errors.push(`Row ${lineNo}: closest_number needs numeric_answer`);
          return;
        }
        const nMin = numMinRaw ? parseFloat(numMinRaw) : n - 100;
        const nMax = numMaxRaw ? parseFloat(numMaxRaw) : n + 100;
        if (!isFinite(nMin) || !isFinite(nMax) || nMax <= nMin) {
          errors.push(`Row ${lineNo}: closest_number needs slider_min < slider_max`);
          return;
        }
        const tol = numTolRaw ? parseFloat(numTolRaw) : Math.max((nMax - nMin) * 0.1, 1);
        const fmt = (answerFormatRaw || "general").toLowerCase().trim();
        const validFmt = ["general", "year", "decimal", "percentage", "currency"].includes(fmt)
          ? fmt
          : "general";
        toInsert.push({
          text: qtext,
          options: [validFmt],
          correct_index: -1,
          time_limit_sec: null,
          point_value: 1000,
          question_type: "number",
          ...base,
          ...emptyExtras,
          correct_number: n,
          number_min: nMin,
          number_max: nMax,
          number_tolerance: isFinite(tol) ? tol : null,
        });
      } else if (qtype === "true_false") {
        const tfOpts = ["TRUE", "FALSE"];
        const v = correctRaw.trim().toLowerCase();
        const ci =
          v === "true" || v === "t" || v === "1" || v === "a"
            ? 0
            : v === "false" || v === "f" || v === "0" || v === "b"
              ? 1
              : -1;
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        if (ci < 0) {
          errors.push(`Row ${lineNo}: true_false correct_answer must be TRUE or FALSE`);
          return;
        }
        toInsert.push({
          text: qtext,
          options: tfOpts,
          correct_index: ci,
          time_limit_sec: null,
          point_value: 1000,
          question_type: "true_false",
          ...base,
          ...emptyExtras,
        });
      } else if (qtype === "type") {
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        const accepted = acceptedRaw
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        if (accepted.length === 0) {
          errors.push(`Row ${lineNo}: text needs accepted_answers (semicolon-separated)`);
          return;
        }
        toInsert.push({
          text: qtext,
          options: [],
          correct_index: -1,
          time_limit_sec: null,
          point_value: 1000,
          question_type: "type",
          ...base,
          ...emptyExtras,
          accepted_answers: accepted,
        });
      } else if (qtype === "feedback") {
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        toInsert.push({
          text: qtext,
          options: [""],
          correct_index: -1,
          time_limit_sec: null,
          point_value: 0,
          question_type: "feedback",
          ...base,
          ...emptyExtras,
        });
      } else if (qtype === "ordering") {
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        const items = (orderRaw ? orderRaw.split(";") : opts).map((s) => s.trim()).filter(Boolean);
        if (items.length < 2) {
          errors.push(`Row ${lineNo}: ordering needs order_items with at least 2 entries`);
          return;
        }
        if (items.length > 8) {
          errors.push(`Row ${lineNo}: ordering supports at most 8 items`);
          return;
        }
        toInsert.push({
          text: qtext,
          options: items,
          correct_index: -1,
          time_limit_sec: null,
          point_value: 1000,
          question_type: "ordering",
          ...base,
          ...emptyExtras,
        });
      } else if (qtype === "image_reveal" || qtype === "audio" || qtype === "image_mcq") {
        opts = opts.map((o) => o.trim()).filter(Boolean);
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        if (opts.length < 2) {
          errors.push(`Row ${lineNo}: ${qtype} needs at least 2 options`);
          return;
        }
        if (opts.length > 6) {
          errors.push(`Row ${lineNo}: max 6 options (got ${opts.length})`);
          return;
        }
        const ci = resolveCorrect(correctRaw, opts);
        if (ci < 0) {
          errors.push(`Row ${lineNo}: correct_answer "${correctRaw}" doesn't match any option`);
          return;
        }
        const stages = revealRaw ? parseInt(revealRaw, 10) : null;
        toInsert.push({
          text: qtext,
          options: opts,
          correct_index: ci,
          time_limit_sec: null,
          point_value: 1000,
          question_type: qtype,
          ...base,
          ...emptyExtras,
          reveal_stages: qtype === "image_reveal" ? (stages && stages > 0 ? stages : 5) : null,
        });
      } else {
        // mcq (default)
        opts = opts.map((o) => o.trim()).filter(Boolean);
        if (!qtext) {
          errors.push(`Row ${lineNo}: missing question text`);
          return;
        }
        if (opts.length < 2) {
          errors.push(`Row ${lineNo}: needs at least 2 options`);
          return;
        }
        if (opts.length > 6) {
          errors.push(`Row ${lineNo}: max 6 options (got ${opts.length})`);
          return;
        }
        const ci = resolveCorrect(correctRaw, opts);
        if (ci < 0) {
          errors.push(`Row ${lineNo}: correct_answer "${correctRaw}" doesn't match any option`);
          return;
        }
        toInsert.push({
          text: qtext,
          options: opts,
          correct_index: ci,
          time_limit_sec: null,
          point_value: 1000,
          question_type: "mcq",
          ...base,
          ...emptyExtras,
        });
      }

      // Unused columns (explanation, map_zoom, match_pairs for non-matching)
      // are intentionally ignored per template design.
      void matchRaw;

      const last = toInsert[toInsert.length - 1];
      if (last) {
        if (timeRaw) {
          const t = parseInt(timeRaw, 10);
          if (isNaN(t) || t < 5 || t > 300) {
            errors.push(`Row ${lineNo}: time_limit "${timeRaw}" must be 5-300`);
            toInsert.pop();
            return;
          }
          last.time_limit_sec = t;
        }
        if (pointsRaw) {
          const p = parseInt(pointsRaw, 10);
          if (isNaN(p) || p < 0 || p > 100000) {
            errors.push(`Row ${lineNo}: points "${pointsRaw}" must be 0-100000`);
            toInsert.pop();
            return;
          }
          last.point_value = p;
        }
      }
      // Record the section cell for whichever row this iteration committed.
      // `toInsert.length > firstFreeRow` is false for every rejected row, so
      // the parallel array stays index-aligned with toInsert.
      if (toInsert.length > firstFreeRow) sectionByRow[toInsert.length - 1] = sectionRaw;
    });

    if (toInsert.length === 0) {
      setCsvErrors(errors.length ? errors : ["No valid rows found in that file."]);
      return;
    }

    // ---- optional `section` column (Phase 12) ----
    // Importing NEVER switches a quiz into categorized mode. On a standard quiz
    // the column is reported and ignored, because silently changing an owner's
    // quiz layout as a side effect of a file import is exactly the surprise
    // this feature has to avoid.
    const sectionIdByRow: (string | null)[] = toInsert.map(() => null);
    if (hasSectionColumn) {
      if (!categorized) {
        errors.push(
          "`section` column ignored — this is a standard quiz. Switch it to a categorized quiz first, then import again.",
        );
      } else {
        const wanted = new Map<string, string>(); // title key -> display title
        sectionByRow.forEach((raw) => {
          const title = normalizeSectionTitle(raw);
          if (!title) return;
          const key = sectionTitleKey(title);
          if (!wanted.has(key)) wanted.set(key, title);
        });

        // Resolve against existing sections first. `sortSections` + first-match
        // wins means the file always lands in the earliest section of a given
        // name, so a duplicate name can never scatter rows unpredictably.
        const keyToId = new Map<string, string>();
        for (const s of sortSections(sections)) {
          const key = sectionTitleKey(s.title);
          if (!keyToId.has(key)) keyToId.set(key, s.id);
        }

        const missing = [...wanted.entries()].filter(([key]) => !keyToId.has(key));
        if (missing.length > 0) {
          const startPosition = nextSectionPosition(sections);
          const { data: created, error: createErr } = await supabase
            .from("quiz_sections")
            .insert(
              missing.map(([, title], i) => ({
                quiz_id: id,
                title,
                position: startPosition + i,
              })),
            )
            .select("id,title");
          if (createErr) {
            logActionError(createErr, "CSV import (sections)");
            setCsvErrors([
              ...errors,
              `We couldn't create the sections — ${safeErrorMessage(createErr)}`,
            ]);
            return;
          }
          for (const row of (created ?? []) as Array<{ id: string; title: string }>) {
            const key = sectionTitleKey(row.title);
            if (!keyToId.has(key)) keyToId.set(key, row.id);
          }
        }

        sectionByRow.forEach((raw, i) => {
          const title = normalizeSectionTitle(raw);
          if (!title) return;
          sectionIdByRow[i] = keyToId.get(sectionTitleKey(title)) ?? null;
        });
      }
    }

    let pos = questions.length;
    const payload = toInsert.map((r, i) => ({
      ...r,
      quiz_id: id,
      position: pos++,
      section_id: sectionIdByRow[i],
    }));
    const { error } = await supabase.from("questions").insert(payload);
    if (error) {
      logActionError(error, "CSV import");
      setCsvErrors([...errors, `We couldn't import that file — ${safeErrorMessage(error)}`]);
      return;
    }
    setCsvErrors(errors);
    toast.success(
      `Imported ${toInsert.length} question${toInsert.length === 1 ? "" : "s"}${errors.length ? ` · ${errors.length} skipped` : ""}`,
    );
    load();
  }

  function downloadBlob(name: string, mime: string, data: string) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  function downloadTemplate() {
    downloadBlob("brainbolt-questions-template.csv", "text/csv", CSV_TEMPLATE);
    downloadBlob("brainbolt-csv-template-README.txt", "text/plain", CSV_README);
  }

  /** RFC-4180 quoting. A field is quoted only when it actually needs it. */
  function csvEscape(value: string): string {
    if (value === "") return "";
    return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  /**
   * Exports the quiz's questions to CSV.
   *
   * Column order is derived from CSV_TEMPLATE so an exported file re-imports
   * into the importer above without changes. `option_e` / `option_f` are
   * spliced in after `option_d` only when some question actually has 5-6
   * options, which keeps the common file identical to the template.
   *
   * `section` is populated only while the quiz is categorized — a standard
   * quiz exports the same file it always would have, with the column blank.
   */
  function exportCsv() {
    const baseHeader = CSV_TEMPLATE.split("\n")[0].split(",");
    const choiceTypes = ["mcq", "image_mcq", "image_reveal", "audio"];
    const maxOptions = questions.reduce(
      (max, q) => (choiceTypes.includes(q.question_type) ? Math.max(max, q.options?.length ?? 0) : max),
      0,
    );
    const extraOptionColumns = ["option_e", "option_f"].slice(
      0,
      Math.max(0, Math.min(6, maxOptions) - 4),
    );
    const header = [
      ...baseHeader.slice(0, 6),
      ...extraOptionColumns,
      ...baseHeader.slice(6),
    ];
    const optionColumns = 4 + extraOptionColumns.length;

    const typeToken: Record<string, string> = {
      mcq: "multiple_choice",
      true_false: "true_false",
      image_mcq: "image_mcq",
      map_pin: "map_pin",
      number: "closest_number",
      type: "text",
      feedback: "free_text",
      image_reveal: "image_reveal",
      audio: "audio",
      ordering: "ordering",
    };
    const letters = ["A", "B", "C", "D", "E", "F"];
    const sectionNameById = new Map(
      sections.map((s) => [s.id, normalizeSectionTitle(s.title)] as const),
    );
    const num = (v: number | null | undefined) => (v == null ? "" : String(v));

    const rows = [...questions]
      .sort((a, b) => (a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : 1))
      .map((q) => {
        const isChoice = choiceTypes.includes(q.question_type);
        const isTF = q.question_type === "true_false";
        const isNumber = q.question_type === "number";
        const isMap = q.question_type === "map_pin";
        const isOrdering = q.question_type === "ordering";
        const isText = q.question_type === "type";
        const opts = isChoice ? (q.options ?? []) : [];
        const optionCells = Array.from(
          { length: optionColumns },
          (_, i) => csvEscape(opts[i] ?? ""),
        );
        const correct = isChoice
          ? (letters[q.correct_index] ?? "")
          : isTF
            ? q.correct_index === 0
              ? "TRUE"
              : "FALSE"
            : "";

        return [
          typeToken[q.question_type] ?? "multiple_choice",
          csvEscape(q.text),
          ...optionCells,
          correct,
          "", // explanation — input-only, never stored on the row
          num(q.time_limit_sec),
          num(q.point_value),
          csvEscape(q.image_url ?? ""),
          csvEscape(q.audio_url ?? ""),
          isMap ? num(q.correct_lat) : "",
          isMap ? num(q.correct_lng) : "",
          "", // map_zoom — accepted but ignored by gameplay
          isNumber ? num(q.correct_number) : "",
          // The importer reads `tolerance` as km radius for map_pin and as the
          // numeric tolerance for closest_number, so it round-trips both.
          isNumber ? num(q.number_tolerance) : isMap ? num(q.max_distance_km) : "",
          isNumber ? csvEscape(q.options?.[0] ?? "general") : "",
          isNumber ? num(q.number_min) : "",
          isNumber ? num(q.number_max) : "",
          isText ? csvEscape((q.accepted_answers ?? []).join(";")) : "",
          q.question_type === "image_reveal" ? num(q.reveal_stages ?? 5) : "",
          isOrdering ? csvEscape((q.options ?? []).join(";")) : "",
          "", // match_pairs — "Match the Pairs" is not playable yet
          q.double_points ? "true" : "false",
          isMap ? csvEscape(q.geo_region_label ?? "") : "",
          categorized ? csvEscape(sectionNameById.get(q.section_id ?? "") ?? "") : "",
        ].join(",");
      });

    const slug =
      normalizeSectionTitle(quiz!.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "quiz";
    downloadBlob(`${slug}-questions.csv`, "text/csv", [header.join(","), ...rows].join("\n"));
    toast.success(
      `Exported ${questions.length} question${questions.length === 1 ? "" : "s"}`,
    );
  }

  async function deleteQuiz() {
    if (!confirm("Delete this quiz and all its questions?")) return;
    const { error } = await supabase.from("quizzes").delete().eq("id", id);
    if (error) return toastError(error, { context: "delete quiz" });
    navigate({ to: "/dashboard" });
  }

  // `!== false` (not truthiness) so a row that somehow lacks the flag reads as
  // included — same default the host console, MCP and the DB column use.
  const excludedCount = questions.filter((q) => q.is_playable === false).length;

  return (
    <HostShell title="Editor">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <Link
          to="/dashboard"
          className="font-mono text-xs uppercase text-foreground/60 hover:text-volt"
        >
          ← Back
        </Link>

        <div className="space-y-4">
          <input
            value={quiz.title}
            onChange={(e) => setQuiz({ ...quiz, title: e.target.value })}
            onBlur={() => saveQuiz({ title: quiz.title })}
            className="w-full bg-transparent font-display text-4xl italic uppercase focus:outline-none border-b border-border focus:border-volt py-2"
          />
          <textarea
            placeholder="DESCRIPTION (OPTIONAL)"
            value={quiz.description ?? ""}
            onChange={(e) => setQuiz({ ...quiz, description: e.target.value })}
            onBlur={() => saveQuiz({ description: quiz.description })}
            className="w-full bg-card border border-border p-3 font-sans text-sm focus:outline-none focus:border-volt"
            rows={2}
          />
          <div className="flex items-center gap-3">
            <label className="font-mono text-xs uppercase text-foreground/60">
              Default time/round
            </label>
            <input
              type="number"
              min={5}
              max={120}
              value={quiz.time_per_question}
              onChange={(e) =>
                setQuiz({ ...quiz, time_per_question: parseInt(e.target.value) || 20 })
              }
              onBlur={() => saveQuiz({ time_per_question: quiz.time_per_question })}
              className="w-20 bg-card border border-border p-2 font-mono text-sm text-center focus:outline-none focus:border-volt"
            />
            <span className="font-mono text-xs text-foreground/40">sec</span>
            {saving && <span className="font-mono text-xs text-foreground/40">saving...</span>}
          </div>
        </div>

        {/* Quiz flow — the only switch that turns sections on at all. */}
        <div className="border border-border bg-card p-5 space-y-3">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Quiz flow
              </p>
              <p className="text-sm text-foreground/70 mt-1">
                {categorized
                  ? "Questions are grouped into named, ordered sections."
                  : "Questions play in one continuous order. This is the default."}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap" role="group" aria-label="Quiz flow">
              <button
                type="button"
                onClick={() => setFlow("flat")}
                aria-pressed={!categorized}
                className={`font-mono text-[11px] uppercase px-3 py-2 border ${
                  !categorized
                    ? "border-volt bg-volt/10 text-volt"
                    : "border-border text-foreground/60 hover:border-volt/60"
                }`}
              >
                Standard quiz
              </button>
              <button
                type="button"
                onClick={() => setFlow("categorized")}
                aria-pressed={categorized}
                className={`font-mono text-[11px] uppercase px-3 py-2 border ${
                  categorized
                    ? "border-volt bg-volt/10 text-volt"
                    : "border-border text-foreground/60 hover:border-volt/60"
                }`}
              >
                Categorized quiz
              </button>
            </div>
          </div>
          {!categorized && sections.length > 0 && (
            <p className="font-mono text-[10px] text-foreground/40">
              {sections.length} saved section{sections.length === 1 ? "" : "s"} are kept and hidden
              while this quiz is standard. Switching back restores them.
            </p>
          )}
        </div>

        {categorized && (
          <SectionManager
            sections={orderedSections}
            questions={questions}
            sectionsError={sectionsError}
            validation={sectionValidation}
            onAdd={addSection}
            onRename={renameSection}
            onMove={moveSection}
            onDelete={deleteSection}
          />
        )}

        <div className="border-t border-border pt-8 space-y-4">
          <div className="flex items-end justify-between flex-wrap gap-2">
            <h2 className="font-display text-2xl italic uppercase">
              Questions · {questions.length}
              {excludedCount > 0 && (
                <span className="text-foreground/40">
                  {" "}
                  · {questions.length - excludedCount} ready to play
                </span>
              )}
            </h2>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={downloadTemplate}
                className="border border-border px-3 py-2.5 font-mono text-xs uppercase hover:border-volt hover:text-volt"
              >
                Template
              </button>
              <CsvButton onImport={importCsv} />
              {questions.length > 0 && (
                <button
                  onClick={exportCsv}
                  title={
                    categorized
                      ? "Download these questions as CSV, including their section names"
                      : "Download these questions as CSV"
                  }
                  className="border border-border px-3 py-2.5 font-mono text-xs uppercase hover:border-volt hover:text-volt"
                >
                  Export CSV
                </button>
              )}
              {questions.length > 0 && (
                <>
                  <button
                    onClick={() => setAllPlayable(true)}
                    disabled={excludedCount === 0}
                    className="border border-border px-3 py-2.5 font-mono text-xs uppercase hover:border-volt hover:text-volt disabled:opacity-30 disabled:hover:border-border disabled:hover:text-foreground"
                  >
                    Include all
                  </button>
                  <button
                    onClick={() => setAllPlayable(false)}
                    className="border border-border px-3 py-2.5 font-mono text-xs uppercase hover:border-pink-shock hover:text-pink-shock"
                  >
                    Exclude all
                  </button>
                </>
              )}
              <button
                onClick={addQuestion}
                className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta"
              >
                + ADD
              </button>
            </div>
          </div>

          <AiQuestionBuilderPanel
            quizId={id}
            startPosition={questions.length}
            currentQuestionCount={questions.length}
            onInsert={(rows) => {
              // The panel already inserted the rows via supabase and passed
              // us the actual DB rows back. Append to local state so the
              // existing per-question cards render them — they keep
              // is_playable=false until the creator toggles per-question.
              setQuestions([...questions, ...(rows as unknown as Question[])]);
            }}
          />

          {csvErrors.length > 0 && (
            <div className="border border-pink-shock/40 bg-pink-shock/5 p-4 space-y-1">
              <p className="font-mono text-xs uppercase text-pink-shock mb-2">
                CSV issues ({csvErrors.length})
              </p>
              <ul className="space-y-0.5 max-h-48 overflow-auto">
                {csvErrors.map((e, i) => (
                  <li key={i} className="font-mono text-[11px] text-foreground/70">
                    • {e}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => setCsvErrors([])}
                className="font-mono text-[10px] uppercase text-foreground/40 hover:text-foreground mt-2"
              >
                dismiss
              </button>
            </div>
          )}

          <div className="space-y-3">
            {(() => {
              // One card renderer shared by both layouts so the flat view stays
              // byte-identical to what it was before Phase 12.
              const renderCard = (q: Question) => {
                const i = questions.findIndex((x) => x.id === q.id);
                return (
                  <QuestionEditor
                    key={q.id}
                    index={i < 0 ? 0 : i}
                    total={questions.length}
                    question={q}
                    quizDefaultTime={quiz.time_per_question}
                    sections={categorized ? orderedSections : null}
                    onAssignSection={(sectionId) => assignQuestionToSection(q.id, sectionId)}
                    onChange={(patch) => updateQuestion(q.id, patch)}
                    onDelete={() => deleteQuestion(q.id)}
                    onMove={(dir) => moveQuestion(q.id, dir)}
                  />
                );
              };

              if (!categorized) return questions.map(renderCard);

              // Categorized: sections in rank order, each with its questions in
              // their existing global `position` order, then an explicit
              // "Ungrouped" bucket. Ordering inside a section is the question's
              // own position, so the ▲/▼ controls keep working unchanged.
              const grouping = groupQuestions(orderedSections, questions);
              const renderGroupHeader = (label: string, count: number, tone: "volt" | "shock") => (
                <div
                  className={`flex items-baseline justify-between gap-2 border-b pb-2 ${
                    tone === "volt" ? "border-volt/30" : "border-pink-shock/40"
                  }`}
                >
                  <p
                    className={`font-mono text-[11px] uppercase tracking-widest ${
                      tone === "volt" ? "text-volt" : "text-pink-shock"
                    }`}
                  >
                    {label}
                  </p>
                  <span className="font-mono text-[10px] text-foreground/40">
                    {count} question{count === 1 ? "" : "s"}
                  </span>
                </div>
              );
              return (
                <div className="space-y-7">
                  {grouping.buckets.map((bucket) => {
                    const section = bucket.section!;
                    return (
                      <div key={section.id} className="space-y-3">
                        {renderGroupHeader(
                          normalizeSectionTitle(section.title) || "Untitled section",
                          bucket.questions.length,
                          "volt",
                        )}
                        {bucket.questions.length === 0 ? (
                          <p className="border border-dashed border-border px-3 py-4 font-mono text-[11px] text-foreground/40">
                            No questions in this section yet. Move one in with its “Section”
                            dropdown — an empty section is skipped during play.
                          </p>
                        ) : (
                          bucket.questions.map(renderCard)
                        )}
                      </div>
                    );
                  })}
                  {grouping.ungrouped && (
                    <div className="space-y-3">
                      {renderGroupHeader(
                        "Ungrouped",
                        grouping.ungrouped.questions.length,
                        "shock",
                      )}
                      <p className="font-mono text-[11px] text-foreground/50">
                        These questions are not in any section. Included questions must be
                        grouped before the quiz can start; feedback slides may stay ungrouped and
                        play after the last section.
                      </p>
                      {grouping.ungrouped.questions.map(renderCard)}
                    </div>
                  )}
                  {grouping.buckets.length === 0 && !grouping.ungrouped && (
                    <p className="border border-dashed border-border px-3 py-4 font-mono text-[11px] text-foreground/40">
                      Add a section above, then move questions into it.
                    </p>
                  )}
                </div>
              );
            })()}
            {questions.length === 0 && (
              <EmptyState
                eyebrow="Questions"
                title="Add your first question"
                body={`Pick a question type above — ${questionTypeListLabel([
                  "mcq",
                  "true_false",
                  "number",
                  "ordering",
                  "image_reveal",
                  "audio",
                  "map_pin",
                  "type",
                  "feedback",
                ]).toLowerCase()}. You can also import a CSV.`}
              />
            )}
          </div>
        </div>

        <div className="pt-8 border-t border-border">
          <button
            onClick={deleteQuiz}
            className="font-mono text-xs uppercase text-pink-shock hover:underline"
          >
            Delete quiz
          </button>
        </div>
        <ScrollToTopButton />
      </div>
    </HostShell>
  );
}

// Floating "back to top" affordance for long question lists. Renders nothing
// until the editor has been scrolled down past the header, then returns the
// user to the title + Add controls in one tap.
function ScrollToTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 480);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      className="fixed bottom-6 right-6 z-50 bg-volt text-background font-display text-sm uppercase px-4 py-3 skew-cta active:scale-95 shadow-[0_0_28px_rgba(204,255,0,0.35)]"
    >
      <ArrowUp className="size-4 inline-block mr-1.5" strokeWidth={2.5} />
      Top
    </button>
  );
}

function QuestionEditor({
  index,
  total,
  question,
  quizDefaultTime,
  sections,
  onAssignSection,
  onChange,
  onDelete,
  onMove,
}: {
  index: number;
  total: number;
  question: Question;
  quizDefaultTime: number;
  /** Non-null only while the quiz is categorized. */
  sections: QuizSection[] | null;
  onAssignSection: (sectionId: string | null) => void;
  onChange: (patch: Partial<Question>) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [local, setLocal] = useState(question);
  useEffect(
    () => setLocal(question),
    [question.id, question.position, question.is_playable, question.section_id],
  );

  function setOption(i: number, val: string) {
    const opts = [...local.options];
    opts[i] = val;
    setLocal({ ...local, options: opts });
  }
  function addOption() {
    if (local.options.length >= 6) return;
    const opts = [...local.options, `Option ${local.options.length + 1}`];
    setLocal({ ...local, options: opts });
    onChange({ options: opts });
  }
  function removeOption(i: number) {
    if (local.options.length <= 2) return;
    const opts = local.options.filter((_, j) => j !== i);
    const correct = local.correct_index >= opts.length ? 0 : local.correct_index;
    const next = { ...local, options: opts, correct_index: correct };
    setLocal(next);
    onChange({ options: opts, correct_index: correct });
  }

  function blurSave() {
    // Send content edits only. Identity, ordering, playability and section
    // membership each have their own writer (add/move/delete, moveQuestion, the
    // play toggle, the Section dropdown) — resending the full row here raced
    // the bulk Enable/Exclude buttons: the blur fired by clicking them could
    // land after the bulk write and silently restore the old flag while the UI
    // showed the new one. The same race applies to choosing a section.
    const patch: Partial<Question> = { ...local };
    delete patch.id;
    delete patch.position;
    delete patch.is_playable;
    delete patch.section_id;
    onChange(patch);
  }

  // Country boundaries for region-based map questions — lazy-loaded on first
  // dropdown focus so the editor bundle stays lean.
  const [regionOptions, setRegionOptions] = useState<CountryRegion[] | null>(null);
  async function openRegionOptions() {
    if (regionOptions) return;
    const mod = await import("@/lib/geo/country-regions");
    setRegionOptions(mod.COUNTRY_REGIONS);
  }
  function applyRegion(name: string) {
    const entry = regionOptions?.find((c) => c.name === name);
    if (!entry) return;
    const next = {
      ...local,
      geo_region: entry.region,
      geo_region_label: entry.name,
      correct_lat: entry.label.lat,
      correct_lng: entry.label.lng,
      max_distance_km:
        local.max_distance_km == null || local.max_distance_km === 5000
          ? 300
          : local.max_distance_km,
    };
    setLocal(next);
    onChange({
      geo_region: next.geo_region,
      geo_region_label: next.geo_region_label,
      correct_lat: next.correct_lat,
      correct_lng: next.correct_lng,
      max_distance_km: next.max_distance_km,
    });
  }
  function clearRegion() {
    const next = { ...local, geo_region: null, geo_region_label: null };
    setLocal(next);
    onChange({ geo_region: null, geo_region_label: null });
  }

  function changeType(t: QuestionType) {
    if (t === "true_false") {
      const next = {
        ...local,
        question_type: t,
        options: ["TRUE", "FALSE"],
        correct_index: local.correct_index > 1 ? 0 : local.correct_index,
      };
      setLocal(next);
      onChange({ question_type: t, options: next.options, correct_index: next.correct_index });
    } else if (t === "map_pin") {
      const next = {
        ...local,
        question_type: t,
        options: [],
        correct_index: -1,
        max_distance_km: local.max_distance_km ?? 5000,
        correct_lat: local.correct_lat ?? 0,
        correct_lng: local.correct_lng ?? 0,
      };
      setLocal(next);
      onChange({
        question_type: t,
        options: [],
        correct_index: -1,
        max_distance_km: next.max_distance_km,
        correct_lat: next.correct_lat,
        correct_lng: next.correct_lng,
      });
    } else if (t === "number") {
      const fmt = (local.options && local.options[0]) || "general";
      const next = {
        ...local,
        question_type: t,
        options: [fmt],
        correct_index: -1,
        correct_number: local.correct_number ?? 50,
        number_min: local.number_min ?? 0,
        number_max: local.number_max ?? 100,
        number_tolerance: local.number_tolerance ?? 10,
      };
      setLocal(next);
      onChange({
        question_type: t,
        options: [fmt],
        correct_index: -1,
        correct_number: next.correct_number,
        number_min: next.number_min,
        number_max: next.number_max,
        number_tolerance: next.number_tolerance,
      });
    } else if (t === "type") {
      const accepted =
        local.accepted_answers && local.accepted_answers.length > 0 ? local.accepted_answers : [""];
      const next = {
        ...local,
        question_type: t,
        options: [],
        correct_index: -1,
        accepted_answers: accepted,
      };
      setLocal(next);
      onChange({ question_type: t, options: [], correct_index: -1, accepted_answers: accepted });
    } else if (t === "feedback") {
      const placeholder = (local.options && local.options[0]) || "";
      const next = {
        ...local,
        question_type: t,
        options: [placeholder],
        correct_index: -1,
        accepted_answers: null,
      };
      setLocal(next);
      onChange({
        question_type: t,
        options: [placeholder],
        correct_index: -1,
        accepted_answers: null,
      });
    } else if (t === "ordering") {
      const opts =
        local.options &&
        local.options.length >= 2 &&
        !["true_false", "map_pin", "number", "type", "feedback"].includes(local.question_type)
          ? local.options
          : ["First", "Second", "Third", "Fourth"];
      const next = {
        ...local,
        question_type: t,
        options: opts,
        correct_index: -1,
        accepted_answers: null,
      };
      setLocal(next);
      onChange({ question_type: t, options: opts, correct_index: -1, accepted_answers: null });
    } else if (t === "image_reveal") {
      const opts =
        local.options &&
        local.options.length >= 2 &&
        !["true_false", "map_pin", "number", "type", "feedback"].includes(local.question_type)
          ? local.options
          : ["Option A", "Option B", "Option C", "Option D"];
      const ci = local.correct_index < 0 ? 0 : Math.min(local.correct_index, opts.length - 1);
      const stages = local.reveal_stages ?? 5;
      const next = {
        ...local,
        question_type: t,
        options: opts,
        correct_index: ci,
        reveal_stages: stages,
      };
      setLocal(next);
      onChange({ question_type: t, options: opts, correct_index: ci, reveal_stages: stages });
    } else {
      const opts =
        local.question_type === "true_false" ||
        local.question_type === "map_pin" ||
        local.question_type === "number" ||
        local.question_type === "type" ||
        local.question_type === "feedback"
          ? ["Option A", "Option B", "Option C", "Option D"]
          : local.options;
      const ci = local.correct_index < 0 ? 0 : local.correct_index;
      const next = { ...local, question_type: t, options: opts, correct_index: ci };
      setLocal(next);
      onChange({ question_type: t, options: opts, correct_index: ci });
    }
  }

  async function uploadImage(file: File) {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${local.id}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("quiz-images")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) {
      toastError(error, { context: "image upload", fallback: "Couldn't upload that image." });
      return;
    }
    const { data: signed, error: sErr } = await supabase.storage
      .from("quiz-images")
      .createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
    if (sErr || !signed?.signedUrl) {
      toastError(sErr, { context: "image signed URL", fallback: "Couldn't get image URL" });
      return;
    }
    setLocal({ ...local, image_url: signed.signedUrl });
    onChange({ image_url: signed.signedUrl });
    toast.success("Image uploaded");
  }

  function clearImage() {
    setLocal({ ...local, image_url: null });
    onChange({ image_url: null });
  }

  async function uploadAudio(file: File) {
    const ext = file.name.split(".").pop() || "mp3";
    const path = `${local.id}-audio-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("quiz-images")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) {
      toastError(error, { context: "audio upload", fallback: "Couldn't upload that audio." });
      return;
    }
    const { data: signed, error: sErr } = await supabase.storage
      .from("quiz-images")
      .createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
    if (sErr || !signed?.signedUrl) {
      toastError(sErr, { context: "audio signed URL", fallback: "Couldn't get audio URL" });
      return;
    }
    setLocal({ ...local, audio_url: signed.signedUrl });
    onChange({ audio_url: signed.signedUrl } as Partial<Question>);
    toast.success("Audio uploaded");
  }

  function clearAudio() {
    setLocal({ ...local, audio_url: null });
    onChange({ audio_url: null } as Partial<Question>);
  }

  const isTF = local.question_type === "true_false";
  const isMap = local.question_type === "map_pin";
  const isNum = local.question_type === "number";
  const isType = local.question_type === "type";
  const isFeedback = local.question_type === "feedback";
  const isReveal = local.question_type === "image_reveal";
  const isAudio = local.question_type === "audio";
  const isOrdering = local.question_type === "ordering";

  function setAcceptedAnswer(i: number, val: string) {
    const arr = [...(local.accepted_answers ?? [])];
    arr[i] = val;
    setLocal({ ...local, accepted_answers: arr });
  }
  function addAcceptedAnswer() {
    const arr = [...(local.accepted_answers ?? []), ""];
    setLocal({ ...local, accepted_answers: arr });
    onChange({ accepted_answers: arr });
  }
  function removeAcceptedAnswer(i: number) {
    const arr = (local.accepted_answers ?? []).filter((_, j) => j !== i);
    setLocal({ ...local, accepted_answers: arr });
    onChange({ accepted_answers: arr });
  }

  return (
    <div
      className={`bg-card border p-5 space-y-4 ${
        local.is_playable !== false ? "border-border" : "border-pink-shock/30 opacity-70"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="font-display text-2xl italic text-volt">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="flex flex-col">
            <button
              onClick={() => onMove(-1)}
              disabled={index === 0}
              className="font-mono text-[10px] text-foreground/40 hover:text-volt disabled:opacity-20"
              title="Move up"
            >
              ▲
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              className="font-mono text-[10px] text-foreground/40 hover:text-volt disabled:opacity-20"
              title="Move down"
            >
              ▼
            </button>
          </div>
        </div>
        <textarea
          value={local.text}
          onChange={(e) => setLocal({ ...local, text: e.target.value })}
          onBlur={blurSave}
          rows={2}
          className="flex-1 bg-background border border-border p-3 text-base focus:outline-none focus:border-volt"
        />
        <button
          onClick={onDelete}
          className="font-mono text-xs uppercase text-pink-shock hover:underline"
        >
          Del
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase text-foreground/60">Type</span>
        {questionTypeOptions().map(({ id: t, label, helpText }) => (
          <button
            key={t}
            type="button"
            onClick={() => changeType(t)}
            title={helpText}
            aria-pressed={local.question_type === t}
            className={`font-mono text-[10px] uppercase px-2 py-1 border ${local.question_type === t ? "border-volt bg-volt/10 text-volt" : "border-border text-foreground/60 hover:border-volt/60"}`}
          >
            {label}
          </button>
        ))}
        <label
          className={`font-mono text-[10px] uppercase px-2 py-1 border cursor-pointer ${local.is_playable === false ? "border-pink-shock bg-pink-shock/10 text-pink-shock" : "border-volt/40 text-volt hover:border-volt"}`}
          title={
            local.is_playable !== false
              ? "Included — players will see this question"
              : "Excluded — stored but never asked during play"
          }
        >
          <input
            type="checkbox"
            checked={local.is_playable === false}
            className="hidden"
            onChange={(e) => {
              const next = !e.target.checked;
              setLocal({ ...local, is_playable: next });
              onChange({ is_playable: next });
            }}
          />
          {local.is_playable !== false ? "Included in play" : "Excluded from play"}
        </label>
        {sections && (
          <label
            className={`font-mono text-[10px] uppercase px-2 py-1 border flex items-center gap-1.5 ${
              local.section_id
                ? "border-cyan-jolt/40 text-cyan-jolt"
                : "border-pink-shock/40 text-pink-shock"
            }`}
            title={
              local.section_id
                ? "This question plays as part of its section"
                : "Not in any section — an included scored question blocks the quiz from starting"
            }
          >
            <span className="text-foreground/50">Section</span>
            <select
              value={local.section_id ?? ""}
              onChange={(e) => {
                const next = e.target.value || null;
                setLocal({ ...local, section_id: next });
                onAssignSection(next);
              }}
              className="bg-background border border-border px-1 py-0.5 font-mono text-[10px] uppercase text-foreground focus:outline-none focus:border-volt max-w-[9rem]"
            >
              <option value="">Ungrouped</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {normalizeSectionTitle(s.title) || "Untitled section"}
                </option>
              ))}
            </select>
          </label>
        )}
        <label
          className={`font-mono text-[10px] uppercase px-2 py-1 border cursor-pointer ml-auto ${local.double_points ? "border-amber-spark bg-amber-spark/10 text-amber-spark" : "border-border text-foreground/60 hover:border-amber-spark/60"}`}
        >
          <input
            type="checkbox"
            checked={local.double_points}
            className="hidden"
            onChange={(e) => {
              setLocal({ ...local, double_points: e.target.checked });
              onChange({ double_points: e.target.checked });
            }}
          />
          ⚡ Double points
        </label>
      </div>

      {isMap && (
        <div className="border border-border p-3 space-y-3 bg-background/40">
          <div className="space-y-1">
            <label className="font-mono text-[10px] uppercase text-foreground/60">
              Region (optional)
            </label>
            <div className="flex gap-2">
              <select
                value={local.geo_region_label ?? ""}
                onFocus={() => void openRegionOptions()}
                onChange={(e) => applyRegion(e.target.value)}
                className="flex-1 bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt"
              >
                <option value="">— none —</option>
                {(regionOptions ?? []).map((c) => (
                  <option key={c.key} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              {local.geo_region && (
                <button
                  type="button"
                  onClick={clearRegion}
                  className="border border-border px-2 font-mono text-[10px] uppercase text-pink-shock hover:border-pink-shock/60"
                >
                  ✕ clear
                </button>
              )}
            </div>
            <p className="font-mono text-[10px] text-foreground/40">
              With a region, any click inside it scores full marks; outside scores by distance from
              the border. Max dist (km) becomes the falloff band.
            </p>
          </div>
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            📍 Correct location — click on the map
          </p>
          <MapPicker
            height={300}
            guess={
              local.correct_lat != null && local.correct_lng != null
                ? { lat: Number(local.correct_lat), lng: Number(local.correct_lng) }
                : null
            }
            region={local.geo_region ?? null}
            center={
              local.geo_region && local.correct_lat != null && local.correct_lng != null
                ? [Number(local.correct_lat), Number(local.correct_lng)]
                : undefined
            }
            zoom={local.geo_region ? 5 : undefined}
            onPick={(lat, lng) => {
              const next = { ...local, correct_lat: lat, correct_lng: lng };
              setLocal(next);
              onChange({ correct_lat: lat, correct_lng: lng });
            }}
          />
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Latitude</span>
              <input
                type="number"
                step="0.0001"
                value={local.correct_lat ?? ""}
                onChange={(e) =>
                  setLocal({
                    ...local,
                    correct_lat: e.target.value === "" ? null : parseFloat(e.target.value),
                  })
                }
                onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt"
              />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Longitude</span>
              <input
                type="number"
                step="0.0001"
                value={local.correct_lng ?? ""}
                onChange={(e) =>
                  setLocal({
                    ...local,
                    correct_lng: e.target.value === "" ? null : parseFloat(e.target.value),
                  })
                }
                onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt"
              />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">
                Max dist (km)
              </span>
              <input
                type="number"
                min={10}
                step="10"
                value={local.max_distance_km ?? 5000}
                onChange={(e) =>
                  setLocal({ ...local, max_distance_km: parseFloat(e.target.value) || 5000 })
                }
                onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt"
              />
            </label>
          </div>
          <p className="font-mono text-[10px] text-foreground/40">
            Point questions: linear falloff from the pin. Region questions: full marks inside,
            linear falloff beyond the border.
          </p>
        </div>
      )}

      {isNum &&
        (() => {
          const numFormat = (local.options && local.options[0]) || "general";
          const isYear = numFormat === "year";
          const isPct = numFormat === "percentage";
          const isDec = numFormat === "decimal";
          const step: any = isYear || numFormat === "general" ? 1 : "any";
          const setFormat = (f: string) => {
            const opts = [f];
            const patch: Partial<Question> = { options: opts };
            if (f === "year" && local.correct_number != null) {
              patch.correct_number = Math.round(local.correct_number);
            }
            setLocal({ ...local, ...patch });
            onChange(patch);
          };
          const parseVal = (raw: string): number | null => {
            if (raw === "") return null;
            const cleaned = raw.replace(/,/g, "").replace(/%/g, "");
            const n = parseFloat(cleaned);
            if (!isFinite(n)) return null;
            if (isYear || numFormat === "general") return Math.trunc(n);
            return n;
          };
          const display = (v: number | null) => {
            if (v == null) return "";
            if (isYear) return String(Math.trunc(v));
            if (numFormat === "general") return Math.trunc(v).toLocaleString();
            return String(v);
          };
          return (
            <div className="border border-border p-3 space-y-3 bg-background/40">
              <p className="font-mono text-[10px] uppercase text-foreground/60">
                🎯 Numeric answer
              </p>
              <label className="space-y-1 block">
                <span className="font-mono text-[10px] uppercase text-foreground/60">
                  Answer format
                </span>
                <select
                  value={numFormat}
                  onChange={(e) => setFormat(e.target.value)}
                  className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt"
                >
                  <option value="general">General Number</option>
                  <option value="year">Year</option>
                  <option value="decimal">Decimal</option>
                  <option value="percentage">Percentage</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-foreground/60">
                    Correct {isYear ? "year" : isPct ? "% value" : "number"}
                  </span>
                  <div className="relative">
                    <input
                      type={isYear || numFormat === "general" ? "text" : "number"}
                      inputMode={isDec || isPct ? "decimal" : "numeric"}
                      step={step}
                      min={isYear ? 1000 : undefined}
                      max={isYear ? 9999 : undefined}
                      value={display(local.correct_number ?? null)}
                      onChange={(e) =>
                        setLocal({ ...local, correct_number: parseVal(e.target.value) })
                      }
                      onBlur={blurSave}
                      placeholder={isYear ? "e.g. 1976" : isPct ? "e.g. 42.5" : ""}
                      className={`w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt ${isPct ? "pr-6" : ""}`}
                    />
                    {isPct && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-xs text-foreground/60">
                        %
                      </span>
                    )}
                  </div>
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-foreground/60">
                    Tolerance (± full pts)
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={step}
                    placeholder="auto"
                    value={local.number_tolerance ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") {
                        setLocal({ ...local, number_tolerance: null });
                        return;
                      }
                      const n = parseFloat(raw);
                      setLocal({
                        ...local,
                        number_tolerance: isYear || numFormat === "general" ? Math.trunc(n) : n,
                      });
                    }}
                    onBlur={blurSave}
                    className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-foreground/60">
                    Slider min
                  </span>
                  <input
                    type="number"
                    step={step}
                    value={local.number_min ?? ""}
                    onChange={(e) =>
                      setLocal({
                        ...local,
                        number_min: e.target.value === "" ? null : parseFloat(e.target.value),
                      })
                    }
                    onBlur={blurSave}
                    className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-foreground/60">
                    Slider max
                  </span>
                  <input
                    type="number"
                    step={step}
                    value={local.number_max ?? ""}
                    onChange={(e) =>
                      setLocal({
                        ...local,
                        number_max: e.target.value === "" ? null : parseFloat(e.target.value),
                      })
                    }
                    onBlur={blurSave}
                    className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt"
                  />
                </label>
              </div>
              <p className="font-mono text-[10px] text-foreground/40">
                Points scale linearly from full (exact) to zero (at ± tolerance). Speed still
                matters.
              </p>
            </div>
          );
        })()}

      {isType && (
        <div className="border border-border p-3 space-y-3 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            ⌨️ Accepted answers — case &amp; punctuation insensitive
          </p>
          <div className="space-y-2">
            {(local.accepted_answers ?? [""]).map((ans, i) => (
              <div key={i} className="flex items-center gap-2 border border-border bg-background">
                <span className="size-10 grid place-items-center shrink-0 font-mono text-xs text-foreground/40">
                  {i === 0 ? "★" : "≈"}
                </span>
                <input
                  value={ans}
                  onChange={(e) => setAcceptedAnswer(i, e.target.value)}
                  onBlur={blurSave}
                  placeholder={
                    i === 0
                      ? "Primary answer (e.g. George Washington)"
                      : "Alternate (e.g. Washington)"
                  }
                  className="flex-1 bg-transparent py-2 px-1 text-sm focus:outline-none"
                />
                {(local.accepted_answers ?? []).length > 1 && (
                  <button
                    onClick={() => removeAcceptedAnswer(i)}
                    className="px-2 font-mono text-xs text-foreground/40 hover:text-pink-shock"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={addAcceptedAnswer}
              className="font-mono text-xs uppercase text-foreground/60 hover:text-volt text-left py-1"
            >
              + Add alternate answer
            </button>
          </div>
          <p className="font-mono text-[10px] text-foreground/40">
            First entry is the "official" answer shown at reveal. All entries match
            case-insensitively and ignore punctuation / extra whitespace.
          </p>
        </div>
      )}

      {isFeedback && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            💬 Open feedback — no correct answer, no scoring
          </p>
          <label className="space-y-1 block">
            <span className="font-mono text-[10px] uppercase text-foreground/60">
              Input placeholder (optional)
            </span>
            <input
              value={(local.options && local.options[0]) || ""}
              onChange={(e) => setLocal({ ...local, options: [e.target.value] })}
              onBlur={() => onChange({ options: local.options })}
              placeholder="e.g. What would you like to see next time?"
              className="w-full bg-background border border-border p-2 text-sm focus:outline-none focus:border-volt"
            />
          </label>
          <p className="font-mono text-[10px] text-foreground/40">
            Responses are collected and shown to the host, grouped by frequency. No points, no
            streaks, no leaderboard impact.
          </p>
        </div>
      )}

      {(local.question_type === "image_mcq" || isReveal || local.image_url) && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            {isReveal ? "🖼️ Reveal image (required)" : "Image"}
          </p>
          {local.image_url && (
            <div className="relative">
              <img src={local.image_url} alt="" className="max-h-48 w-auto border border-border" />
              <button
                onClick={clearImage}
                className="absolute top-1 right-1 bg-background/80 border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-pink-shock hover:bg-pink-shock/10"
              >
                Remove
              </button>
            </div>
          )}
          <label className="border border-border px-3 py-2 font-mono text-[10px] uppercase cursor-pointer hover:border-volt hover:text-volt inline-block">
            {local.image_url ? "Replace image" : "Upload image"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadImage(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      )}

      {isReveal && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            🖼️ Image reveal — image starts blurred and sharpens over the round
          </p>
          <label className="space-y-1 block max-w-[220px]">
            <span className="font-mono text-[10px] uppercase text-foreground/60">
              Reveal stages (2–10)
            </span>
            <input
              type="number"
              min={2}
              max={10}
              value={local.reveal_stages ?? 5}
              onChange={(e) => {
                const v = Math.max(2, Math.min(10, parseInt(e.target.value) || 5));
                setLocal({ ...local, reveal_stages: v });
              }}
              onBlur={() => onChange({ reveal_stages: local.reveal_stages ?? 5 })}
              className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt"
            />
          </label>
          <p className="font-mono text-[10px] text-foreground/40">
            Reveal duration = time limit (below). Faster correct answers earn more points via the
            existing speed bonus.
          </p>
        </div>
      )}

      {isAudio && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            🎧 Audio clip (required) — autoplays once when the round starts, no replay
          </p>
          {local.audio_url && (
            <div className="flex items-center gap-2">
              <audio controls src={local.audio_url} className="w-full max-w-md" />
              <button
                onClick={clearAudio}
                className="border border-border px-2 py-1 font-mono text-[10px] uppercase text-pink-shock hover:bg-pink-shock/10"
              >
                Remove
              </button>
            </div>
          )}
          <label className="border border-border px-3 py-2 font-mono text-[10px] uppercase cursor-pointer hover:border-volt hover:text-volt inline-block">
            {local.audio_url ? "Replace audio" : "Upload audio (mp3, wav, m4a, ogg)"}
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadAudio(f);
                e.target.value = "";
              }}
            />
          </label>
          <p className="font-mono text-[10px] text-foreground/40">
            Faster correct answers earn more via the existing speed bonus.
          </p>
        </div>
      )}

      {isOrdering && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">
            🔀 Ordering — list items top→bottom in the correct order. Players see them shuffled and
            drag to reorder.
          </p>
          <div className="space-y-2">
            {local.options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2 border border-border bg-background">
                <span className="size-10 grid place-items-center shrink-0 font-mono text-xs text-volt bg-volt/10">
                  {i + 1}
                </span>
                <input
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value)}
                  onBlur={blurSave}
                  placeholder={`Item ${i + 1}`}
                  className="flex-1 bg-transparent py-2 px-1 text-sm focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (i === 0) return;
                    const opts = [...local.options];
                    [opts[i - 1], opts[i]] = [opts[i], opts[i - 1]];
                    setLocal({ ...local, options: opts });
                    onChange({ options: opts });
                  }}
                  disabled={i === 0}
                  className="px-2 font-mono text-xs text-foreground/40 hover:text-volt disabled:opacity-20"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (i === local.options.length - 1) return;
                    const opts = [...local.options];
                    [opts[i + 1], opts[i]] = [opts[i], opts[i + 1]];
                    setLocal({ ...local, options: opts });
                    onChange({ options: opts });
                  }}
                  disabled={i === local.options.length - 1}
                  className="px-2 font-mono text-xs text-foreground/40 hover:text-volt disabled:opacity-20"
                >
                  ▼
                </button>
                {local.options.length > 2 && (
                  <button
                    onClick={() => removeOption(i)}
                    className="px-2 font-mono text-xs text-foreground/40 hover:text-pink-shock"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {local.options.length < 8 && (
              <button
                onClick={addOption}
                className="font-mono text-xs uppercase text-foreground/60 hover:text-volt text-left py-1"
              >
                + Add item
              </button>
            )}
          </div>
          <p className="font-mono text-[10px] text-foreground/40">
            Partial credit: points scale with how many items are placed correctly. Full order = full
            points + speed bonus.
          </p>
        </div>
      )}

      {isMap || isNum || isType || isFeedback || isOrdering ? null : isTF ? (
        <div className="grid grid-cols-2 gap-2">
          {["TRUE", "FALSE"].map((label, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setLocal({ ...local, correct_index: i });
                onChange({ correct_index: i });
              }}
              className={`p-4 border-2 font-display text-xl italic ${local.correct_index === i ? (i === 0 ? "border-volt bg-volt/10 text-volt" : "border-pink-shock bg-pink-shock/10 text-pink-shock") : "border-border text-foreground/60 hover:border-foreground/40"}`}
            >
              {local.correct_index === i ? "✓ " : ""}
              {label}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          {local.options.map((opt, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 border ${local.correct_index === i ? "border-volt bg-volt/5" : "border-border"}`}
            >
              <button
                type="button"
                onClick={() => {
                  setLocal({ ...local, correct_index: i });
                  onChange({ correct_index: i });
                }}
                className={`size-10 grid place-items-center shrink-0 font-mono text-xs ${local.correct_index === i ? "bg-volt text-background" : "text-foreground/40 hover:text-volt"}`}
                title="Mark correct"
              >
                {local.correct_index === i ? "✓" : ["A", "B", "C", "D", "E", "F"][i]}
              </button>
              <input
                value={opt}
                onChange={(e) => setOption(i, e.target.value)}
                onBlur={blurSave}
                className="flex-1 bg-transparent py-2 px-1 text-sm focus:outline-none"
              />
              {local.options.length > 2 && (
                <button
                  onClick={() => removeOption(i)}
                  className="px-2 font-mono text-xs text-foreground/40 hover:text-pink-shock"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {local.options.length < 6 && (
            <button
              onClick={addOption}
              className="font-mono text-xs uppercase text-foreground/60 hover:text-volt text-left py-1"
            >
              + Add option
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">
            Time limit (sec)
          </span>
          <input
            type="number"
            min={5}
            max={300}
            placeholder={`default ${quizDefaultTime}`}
            value={local.time_limit_sec ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? null : parseInt(e.target.value);
              setLocal({ ...local, time_limit_sec: v });
            }}
            onBlur={() => onChange({ time_limit_sec: local.time_limit_sec })}
            className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt"
          />
        </label>
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Point value</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={local.point_value ?? 1000}
            onChange={(e) => setLocal({ ...local, point_value: parseInt(e.target.value) || 1000 })}
            onBlur={() => onChange({ point_value: local.point_value })}
            className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt"
          />
        </label>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sections (Phase 12)                                                */
/* ------------------------------------------------------------------ */

function SectionManager({
  sections,
  questions,
  sectionsError,
  validation,
  onAdd,
  onRename,
  onMove,
  onDelete,
}: {
  sections: QuizSection[];
  questions: Question[];
  sectionsError: unknown;
  validation: SectionValidation;
  onAdd: () => void;
  onRename: (sectionId: string, title: string) => Promise<boolean>;
  onMove: (sectionId: string, dir: -1 | 1) => void;
  onDelete: (sectionId: string) => void;
}) {
  const sectionIds = new Set(sections.map((s) => s.id));
  const countBySection = new Map<string, number>();
  const playableBySection = new Map<string, number>();
  let ungroupedTotal = 0;
  let ungroupedPlayable = 0;
  for (const q of questions) {
    const sid = q.section_id ?? null;
    if (!sid || !sectionIds.has(sid)) {
      ungroupedTotal += 1;
      if (q.is_playable !== false) ungroupedPlayable += 1;
      continue;
    }
    countBySection.set(sid, (countBySection.get(sid) ?? 0) + 1);
    if (q.is_playable !== false) {
      playableBySection.set(sid, (playableBySection.get(sid) ?? 0) + 1);
    }
  }

  return (
    <div className="border border-volt/40 bg-card p-5 space-y-4">
      <div className="flex items-end justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">Sections</p>
          <p className="text-sm text-foreground/70 mt-1">
            Questions play section by section, in the order below.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
        >
          + Add section
        </button>
      </div>

      {sectionsError ? (
        <p className="border border-pink-shock/40 bg-pink-shock/5 p-3 font-mono text-[11px] text-pink-shock">
          Sections could not be loaded — {safeErrorMessage(sectionsError)}. Question editing still
          works, but grouping is unavailable until sections can be read.
        </p>
      ) : sections.length === 0 ? (
        <p className="border border-dashed border-border px-3 py-4 font-mono text-[11px] text-foreground/40">
          No sections yet. Add one, then use each question's “Section” dropdown to move it in.
        </p>
      ) : (
        <div className="space-y-2">
          {sections.map((s, i) => (
            <SectionRow
              key={s.id}
              section={s}
              index={i}
              total={sections.length}
              questionCount={countBySection.get(s.id) ?? 0}
              playableCount={playableBySection.get(s.id) ?? 0}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {ungroupedTotal > 0 && (
        <p className="font-mono text-[11px] text-foreground/50">
          {ungroupedTotal} question{ungroupedTotal === 1 ? "" : "s"} not in any section
          {ungroupedPlayable > 0 ? ` (${ungroupedPlayable} included in play)` : ""} — listed under
          “Ungrouped” with the questions.
        </p>
      )}

      <SectionValidationPanel validation={validation} />
    </div>
  );
}

function SectionRow({
  section,
  index,
  total,
  questionCount,
  playableCount,
  onRename,
  onMove,
  onDelete,
}: {
  section: QuizSection;
  index: number;
  total: number;
  questionCount: number;
  playableCount: number;
  onRename: (sectionId: string, title: string) => Promise<boolean>;
  onMove: (sectionId: string, dir: -1 | 1) => void;
  onDelete: (sectionId: string) => void;
}) {
  const storedTitle = normalizeSectionTitle(section.title);
  const [title, setTitle] = useState(storedTitle);
  useEffect(() => setTitle(storedTitle), [section.id, storedTitle]);
  const blank = normalizeSectionTitle(title).length === 0;

  async function commit() {
    const ok = await onRename(section.id, title);
    // Revert the input when the name was rejected (blank, or the write failed)
    // so the field always shows what is actually stored.
    if (!ok) setTitle(storedTitle);
  }

  return (
    <div
      className={`border bg-background p-3 flex flex-col gap-2 sm:flex-row sm:items-center ${
        blank ? "border-pink-shock/50" : "border-border"
      }`}
    >
      <span className="font-display text-xl italic text-volt shrink-0 sm:w-8">
        {String(index + 1).padStart(2, "0")}
      </span>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        maxLength={SECTION_TITLE_MAX}
        placeholder="Section name"
        aria-label={`Section ${index + 1} name`}
        className="flex-1 min-w-0 bg-card border border-border px-2 py-1.5 text-sm focus:outline-none focus:border-volt"
      />
      <span className="font-mono text-[10px] uppercase text-foreground/40 shrink-0">
        {questionCount} question{questionCount === 1 ? "" : "s"}
        {playableCount !== questionCount ? ` · ${playableCount} in play` : ""}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onMove(section.id, -1)}
          disabled={index === 0}
          title="Move section up"
          className="px-2 py-1 font-mono text-xs text-foreground/40 hover:text-volt disabled:opacity-20"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={() => onMove(section.id, 1)}
          disabled={index === total - 1}
          title="Move section down"
          className="px-2 py-1 font-mono text-xs text-foreground/40 hover:text-volt disabled:opacity-20"
        >
          ▼
        </button>
        <button
          type="button"
          onClick={() => onDelete(section.id)}
          title="Delete section — its questions are kept"
          className="px-2 py-1 font-mono text-[10px] uppercase text-pink-shock hover:underline"
        >
          Del
        </button>
      </div>
    </div>
  );
}

function SectionValidationPanel({ validation }: { validation: SectionValidation }) {
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`font-mono text-[10px] uppercase tracking-widest ${
            validation.ok ? "text-volt" : "text-pink-shock"
          }`}
        >
          {validation.ok
            ? "Ready to play"
            : `Not ready to play — ${validation.errors.length} issue${
                validation.errors.length === 1 ? "" : "s"
              }`}
        </span>
        <span className="font-mono text-[10px] text-foreground/40">
          {validation.groupedPlayableCount} grouped
          {validation.ungroupedPlayableCount > 0
            ? ` · ${validation.ungroupedPlayableCount} ungrouped feedback`
            : ""}
        </span>
      </div>
      {validation.errors.length > 0 && (
        <ul className="space-y-1">
          {validation.errors.map((issue, i) => (
            <li key={`err-${i}`} className="font-mono text-[11px] text-pink-shock leading-snug">
              ✕ {issue.message}
            </li>
          ))}
        </ul>
      )}
      {validation.warnings.length > 0 && (
        <ul className="space-y-1">
          {validation.warnings.map((issue, i) => (
            <li key={`warn-${i}`} className="font-mono text-[11px] text-amber-spark leading-snug">
              ! {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CsvButton({ onImport }: { onImport: (text: string) => void }) {  return (
    <label className="border border-border px-4 py-2.5 font-mono text-xs uppercase cursor-pointer hover:border-volt hover:text-volt">
      Import CSV
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          f.text()
            .then(onImport)
            .catch((err) =>
              toastError(err, { context: "CSV file read", fallback: "Couldn't read that file." }),
            );
          e.target.value = "";
        }}
      />
    </label>
  );
}
