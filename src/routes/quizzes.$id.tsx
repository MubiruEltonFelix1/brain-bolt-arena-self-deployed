import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { EmptyState } from "@/components/EmptyState";
import { useAuthUser } from "@/hooks/use-auth-user";
import { MapPicker } from "@/components/MapPicker";
import { toast } from "sonner";

export const Route = createFileRoute("/quizzes/$id")({
  component: QuizEditor,
});

type Quiz = { id: string; title: string; description: string | null; time_per_question: number; owner_principal_id: string };
type QuestionType = "mcq" | "true_false" | "image_mcq" | "map_pin" | "number" | "type" | "feedback" | "image_reveal" | "audio" | "ordering";
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
};

// Universal BrainBolt CSV template. Every column is optional except
// `question_type` and `question`; the importer ignores columns that do not
// apply to a given row's type. Old templates (question,option_a..d,correct,
// time,points) continue to import unchanged.
const CSV_TEMPLATE = `question_type,question,option_a,option_b,option_c,option_d,correct_answer,explanation,time_limit,points,image_url,audio_url,map_latitude,map_longitude,map_zoom,numeric_answer,tolerance,answer_format,slider_min,slider_max,accepted_answers,reveal_duration,order_items,match_pairs,double_points
multiple_choice,What is 2 + 2?,1,2,3,4,D,Basic arithmetic,20,1000,,,,,,,,,,,,,,,false
true_false,The sky is blue on a clear day.,,,,,TRUE,,15,1000,,,,,,,,,,,,,,,false
multiple_choice,Largest planet in our solar system?,Earth,Mars,Jupiter,Venus,Jupiter,Gas giant,25,2000,,,,,,,,,,,,,,,true
text,Which fruit keeps the doctor away?,,,,,,Common English proverb,20,1000,,,,,,,,,,,apple;an apple;apples,,,,false
free_text,What did you enjoy most about today?,,,,,,Open feedback question,30,0,,,,,,,,,,,,,,,false
closest_number,In what year did the Berlin Wall fall?,,,,,,Historical event,25,1000,,,,,,1989,2,year,1950,2000,,,,,false
map_pin,Locate Paris on the map,,,,,,Capital of France,30,1000,,,48.8566,2.3522,4,,3000,,,,,,,,false
image_reveal,Guess the landmark as the image reveals,Eiffel Tower,Big Ben,Colosseum,Statue of Liberty,Eiffel Tower,,30,1500,https://example.com/landmark.jpg,,,,,,,,,,,5,,,false
audio,Name this song,Song A,Song B,Song C,Song D,Song B,,25,1000,,https://example.com/clip.mp3,,,,,,,,,,,,,false
ordering,Put these events in chronological order,,,,,,Earliest to latest,45,1500,,,,,,,,,,,,,Wake up;Eat breakfast;Go to school;Study,,false
matching,Match each country to its capital,,,,,,Not yet supported in gameplay,30,1000,,,,,,,,,,,,,,France=Paris;Japan=Tokyo;Kenya=Nairobi,false
`;

const CSV_README = `BrainBolt CSV Template - Column Reference
=========================================

Required columns
----------------
question_type   One of: multiple_choice, true_false, text, free_text,
                closest_number, map_pin, image_reveal, audio, ordering,
                matching. Aliases accepted (mcq, tf, number, geo, etc).
question        The prompt shown to players.

Common optional columns
-----------------------
time_limit      Seconds allowed (5-300). Alias: time_limit_sec, time.
points          Points awarded (1-100000). Alias: point_value.
explanation     Free text shown as context. Currently stored only in CSV;
                ignored by gameplay.
double_points   true/false. Doubles score for the round.
image_url       Optional cover image for the question.

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
                  defaults to 5000). map_zoom is accepted but currently
                  ignored by gameplay.
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
points still import exactly as before. Unknown columns are ignored.
`;

function QuizEditor() {
  const { id } = Route.useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [saving, setSaving] = useState(false);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);

  async function load() {
    const { data: q } = await supabase.from("quizzes").select("*").eq("id", id).maybeSingle();
    if (!q) return navigate({ to: "/dashboard" });
    setQuiz(q as Quiz);
    const { data: qs } = await supabase.from("questions").select("*").eq("quiz_id", id).order("position");
    setQuestions((qs as Question[] | null) ?? []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  if (!quiz) return <HostShell><div className="p-12 font-mono text-sm text-foreground/40">LOADING...</div></HostShell>;
  if (user && quiz.owner_principal_id !== user.id) return <HostShell><div className="p-12">Not your quiz.</div></HostShell>;

  async function saveQuiz(patch: Partial<Quiz>) {
    setSaving(true);
    const { error } = await supabase.from("quizzes").update(patch).eq("id", id);
    setSaving(false);
    if (error) return toast.error(error.message);
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
    if (error || !data) return toast.error(error?.message ?? "Failed");
    setQuestions([...questions, data as Question]);
  }

  async function updateQuestion(qid: string, patch: Partial<Question>) {
    setQuestions((prev) => prev.map((q) => (q.id === qid ? { ...q, ...patch } : q)));
    const { error } = await supabase.from("questions").update(patch as any).eq("id", qid);
    if (error) toast.error(error.message);
  }

  async function deleteQuestion(qid: string) {
    const next = questions.filter((q) => q.id !== qid).map((q, i) => ({ ...q, position: i }));
    setQuestions(next);
    await supabase.from("questions").delete().eq("id", qid);
    // re-persist positions
    await Promise.all(next.map((q) => supabase.from("questions").update({ position: q.position }).eq("id", q.id)));
  }

  async function moveQuestion(qid: string, dir: -1 | 1) {
    const idx = questions.findIndex((q) => q.id === qid);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= questions.length) return;
    const next = [...questions];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    const reposed = next.map((q, i) => ({ ...q, position: i }));
    setQuestions(reposed);
    await Promise.all([
      supabase.from("questions").update({ position: idx }).eq("id", next[idx].id),
      supabase.from("questions").update({ position: swap }).eq("id", next[swap].id),
    ]);
  }

  // ---- CSV import ----
  function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
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
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (rows.length === 0) return toast.error("Empty CSV file");

    const normalizeHeader = (s: string) =>
      s.toLowerCase().trim().replace(/[\s-]+/g, "_").replace(/[^\w]/g, "");
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
    type InsertRow = {
      text: string; options: string[]; correct_index: number;
      time_limit_sec: number | null; point_value: number;
      question_type: QuestionType; image_url: string | null; double_points: boolean;
      correct_lat: number | null; correct_lng: number | null; max_distance_km: number | null;
      correct_number: number | null; number_min: number | null; number_max: number | null; number_tolerance: number | null;
      accepted_answers: string[] | null;
      audio_url: string | null;
      reveal_stages: number | null;
    };
    const toInsert: InsertRow[] = [];

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
      let latRaw = "", lngRaw = "", maxDistRaw = "";
      let numRaw = "", numMinRaw = "", numMaxRaw = "", numTolRaw = "";
      let audioRaw = "", acceptedRaw = "", orderRaw = "", matchRaw = "";
      let revealRaw = "", answerFormatRaw = "";

      if (header.length) {
        const get = (name: string) => {
          const i = header.indexOf(name);
          return i >= 0 ? (parts[i] ?? "") : "";
        };
        qtext = get("question") || get("q") || get("prompt");
        const optNames = ["option_a","option_b","option_c","option_d","option_e","option_f"];
        opts = optNames.map(get).filter((v) => v !== "");
        if (opts.length < 2) {
          const altNames = ["opt1","opt2","opt3","opt4","opt5","opt6"];
          const alt = altNames.map(get).filter((v) => v !== "");
          if (alt.length >= 2) opts = alt;
        }
        correctRaw = get("correct_answer") || get("correct") || get("answer") || get("correct_index");
        timeRaw = get("time_limit") || get("time_limit_sec") || get("time") || get("seconds");
        pointsRaw = get("points") || get("point_value");
        typeRaw = get("question_type") || get("type");
        imageRaw = get("image_url") || get("image");
        dblRaw = get("double_points") || get("double");
        latRaw = get("map_latitude") || get("correct_lat") || get("lat") || get("latitude");
        lngRaw = get("map_longitude") || get("correct_lng") || get("lng") || get("lon") || get("long") || get("longitude");
        // For map_pin `tolerance` = km radius; for number it's numeric tolerance.
        const genericTol = get("tolerance");
        maxDistRaw = get("max_distance_km") || get("max_km") || "";
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
        if (t === "true_false" || t === "truefalse" || t === "tf" || t === "boolean") return "true_false";
        if (t === "image_mcq") return "image_mcq";
        if (t === "map_pin" || t === "map" || t === "geo") return "map_pin";
        if (t === "number" || t === "numeric" || t === "slider" || t === "closest_number" || t === "closest") return "number";
        if (t === "text" || t === "type" || t === "short_answer") return "type";
        if (t === "feedback" || t === "free_text" || t === "opinion" || t === "open") return "feedback";
        if (t === "image_reveal" || t === "reveal" || t === "image") return "image_reveal";
        if (t === "audio" || t === "sound") return "audio";
        if (t === "ordering" || t === "order" || t === "sequence") return "ordering";
        if (t === "matching" || t === "match" || t === "pairs") return "matching";
        return "mcq";
      })();

      if (qtype === "matching") {
        errors.push(`Row ${lineNo}: "matching" question type is not yet supported in gameplay`);
        return;
      }

      const base = {
        image_url: imageRaw.trim() || null,
        double_points: /^(1|true|yes|y)$/i.test(dblRaw.trim()),
      };
      const emptyExtras = {
        correct_lat: null as number | null, correct_lng: null as number | null, max_distance_km: null as number | null,
        correct_number: null as number | null, number_min: null as number | null, number_max: null as number | null, number_tolerance: null as number | null,
        accepted_answers: null as string[] | null,
        audio_url: audioRaw.trim() || null,
        reveal_stages: null as number | null,
      };

      if (qtype === "map_pin") {
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        const lat = parseFloat(latRaw), lng = parseFloat(lngRaw);
        if (!isFinite(lat) || lat < -90 || lat > 90) { errors.push(`Row ${lineNo}: map_pin needs map_latitude (-90..90)`); return; }
        if (!isFinite(lng) || lng < -180 || lng > 180) { errors.push(`Row ${lineNo}: map_pin needs map_longitude (-180..180)`); return; }
        const maxKm = maxDistRaw ? parseFloat(maxDistRaw) : 5000;
        toInsert.push({
          text: qtext, options: [], correct_index: -1,
          time_limit_sec: null, point_value: 1000, question_type: "map_pin",
          ...base, ...emptyExtras,
          correct_lat: lat, correct_lng: lng, max_distance_km: isFinite(maxKm) ? maxKm : 5000,
        });
      } else if (qtype === "number") {
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        const n = parseFloat(numRaw);
        if (!isFinite(n)) { errors.push(`Row ${lineNo}: closest_number needs numeric_answer`); return; }
        const nMin = numMinRaw ? parseFloat(numMinRaw) : n - 100;
        const nMax = numMaxRaw ? parseFloat(numMaxRaw) : n + 100;
        if (!isFinite(nMin) || !isFinite(nMax) || nMax <= nMin) {
          errors.push(`Row ${lineNo}: closest_number needs slider_min < slider_max`); return;
        }
        const tol = numTolRaw ? parseFloat(numTolRaw) : Math.max((nMax - nMin) * 0.1, 1);
        const fmt = (answerFormatRaw || "general").toLowerCase().trim();
        const validFmt = ["general","year","decimal","percentage","currency"].includes(fmt) ? fmt : "general";
        toInsert.push({
          text: qtext, options: [validFmt], correct_index: -1,
          time_limit_sec: null, point_value: 1000, question_type: "number",
          ...base, ...emptyExtras,
          correct_number: n, number_min: nMin, number_max: nMax, number_tolerance: isFinite(tol) ? tol : null,
        });
      } else if (qtype === "true_false") {
        const tfOpts = ["TRUE", "FALSE"];
        const v = correctRaw.trim().toLowerCase();
        const ci = v === "true" || v === "t" || v === "1" || v === "a" ? 0
          : v === "false" || v === "f" || v === "0" || v === "b" ? 1 : -1;
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        if (ci < 0) { errors.push(`Row ${lineNo}: true_false correct_answer must be TRUE or FALSE`); return; }
        toInsert.push({
          text: qtext, options: tfOpts, correct_index: ci,
          time_limit_sec: null, point_value: 1000, question_type: "true_false",
          ...base, ...emptyExtras,
        });
      } else if (qtype === "type") {
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        const accepted = acceptedRaw.split(";").map((s) => s.trim()).filter(Boolean);
        if (accepted.length === 0) { errors.push(`Row ${lineNo}: text needs accepted_answers (semicolon-separated)`); return; }
        toInsert.push({
          text: qtext, options: [], correct_index: -1,
          time_limit_sec: null, point_value: 1000, question_type: "type",
          ...base, ...emptyExtras,
          accepted_answers: accepted,
        });
      } else if (qtype === "feedback") {
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        toInsert.push({
          text: qtext, options: [""], correct_index: -1,
          time_limit_sec: null, point_value: 0, question_type: "feedback",
          ...base, ...emptyExtras,
        });
      } else if (qtype === "ordering") {
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        const items = (orderRaw ? orderRaw.split(";") : opts).map((s) => s.trim()).filter(Boolean);
        if (items.length < 2) { errors.push(`Row ${lineNo}: ordering needs order_items with at least 2 entries`); return; }
        if (items.length > 8) { errors.push(`Row ${lineNo}: ordering supports at most 8 items`); return; }
        toInsert.push({
          text: qtext, options: items, correct_index: -1,
          time_limit_sec: null, point_value: 1000, question_type: "ordering",
          ...base, ...emptyExtras,
        });
      } else if (qtype === "image_reveal" || qtype === "audio" || qtype === "image_mcq") {
        opts = opts.map((o) => o.trim()).filter(Boolean);
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        if (opts.length < 2) { errors.push(`Row ${lineNo}: ${qtype} needs at least 2 options`); return; }
        if (opts.length > 6) { errors.push(`Row ${lineNo}: max 6 options (got ${opts.length})`); return; }
        const ci = resolveCorrect(correctRaw, opts);
        if (ci < 0) { errors.push(`Row ${lineNo}: correct_answer "${correctRaw}" doesn't match any option`); return; }
        const stages = revealRaw ? parseInt(revealRaw, 10) : null;
        toInsert.push({
          text: qtext, options: opts, correct_index: ci,
          time_limit_sec: null, point_value: 1000, question_type: qtype,
          ...base, ...emptyExtras,
          reveal_stages: qtype === "image_reveal" ? (stages && stages > 0 ? stages : 5) : null,
        });
      } else {
        // mcq (default)
        opts = opts.map((o) => o.trim()).filter(Boolean);
        if (!qtext) { errors.push(`Row ${lineNo}: missing question text`); return; }
        if (opts.length < 2) { errors.push(`Row ${lineNo}: needs at least 2 options`); return; }
        if (opts.length > 6) { errors.push(`Row ${lineNo}: max 6 options (got ${opts.length})`); return; }
        const ci = resolveCorrect(correctRaw, opts);
        if (ci < 0) { errors.push(`Row ${lineNo}: correct_answer "${correctRaw}" doesn't match any option`); return; }
        toInsert.push({
          text: qtext, options: opts, correct_index: ci,
          time_limit_sec: null, point_value: 1000, question_type: "mcq",
          ...base, ...emptyExtras,
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
            errors.push(`Row ${lineNo}: time_limit "${timeRaw}" must be 5-300`); toInsert.pop(); return;
          }
          last.time_limit_sec = t;
        }
        if (pointsRaw) {
          const p = parseInt(pointsRaw, 10);
          if (isNaN(p) || p < 0 || p > 100000) {
            errors.push(`Row ${lineNo}: points "${pointsRaw}" must be 0-100000`); toInsert.pop(); return;
          }
          last.point_value = p;
        }
      }
    });


    if (toInsert.length === 0) {
      setCsvErrors(errors);
      toast.error(`No valid rows. ${errors.length} error(s).`);
      return;
    }

    let pos = questions.length;
    const payload = toInsert.map((r) => ({ ...r, quiz_id: id, position: pos++ }));
    const { error } = await supabase.from("questions").insert(payload);
    if (error) {
      setCsvErrors([...errors, `Database error: ${error.message}`]);
      toast.error("Import failed: " + error.message);
      return;
    }
    setCsvErrors(errors);
    toast.success(`Imported ${toInsert.length} question${toInsert.length === 1 ? "" : "s"}${errors.length ? ` · ${errors.length} skipped` : ""}`);
    load();
  }

  function downloadBlob(name: string, mime: string, data: string) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  function downloadTemplate() {
    downloadBlob("brainbolt-questions-template.csv", "text/csv", CSV_TEMPLATE);
    downloadBlob("brainbolt-csv-template-README.txt", "text/plain", CSV_README);
  }

  async function deleteQuiz() {
    if (!confirm("Delete this quiz and all its questions?")) return;
    await supabase.from("quizzes").delete().eq("id", id);
    navigate({ to: "/dashboard" });
  }

  return (
    <HostShell title="Editor">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <Link to="/dashboard" className="font-mono text-xs uppercase text-foreground/60 hover:text-volt">← Back</Link>

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
            <label className="font-mono text-xs uppercase text-foreground/60">Default time/round</label>
            <input
              type="number"
              min={5}
              max={120}
              value={quiz.time_per_question}
              onChange={(e) => setQuiz({ ...quiz, time_per_question: parseInt(e.target.value) || 20 })}
              onBlur={() => saveQuiz({ time_per_question: quiz.time_per_question })}
              className="w-20 bg-card border border-border p-2 font-mono text-sm text-center focus:outline-none focus:border-volt"
            />
            <span className="font-mono text-xs text-foreground/40">sec</span>
            {saving && <span className="font-mono text-xs text-foreground/40">saving...</span>}
          </div>
        </div>

        <div className="border-t border-border pt-8 space-y-4">
          <div className="flex items-end justify-between flex-wrap gap-2">
            <h2 className="font-display text-2xl italic uppercase">Questions · {questions.length}</h2>
            <div className="flex gap-2 flex-wrap">
              <button onClick={downloadTemplate} className="border border-border px-3 py-2.5 font-mono text-xs uppercase hover:border-volt hover:text-volt">
                Template
              </button>
              <CsvButton onImport={importCsv} />
              <button onClick={addQuestion} className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta">
                + ADD
              </button>
            </div>
          </div>

          {csvErrors.length > 0 && (
            <div className="border border-pink-shock/40 bg-pink-shock/5 p-4 space-y-1">
              <p className="font-mono text-xs uppercase text-pink-shock mb-2">CSV issues ({csvErrors.length})</p>
              <ul className="space-y-0.5 max-h-48 overflow-auto">
                {csvErrors.map((e, i) => (
                  <li key={i} className="font-mono text-[11px] text-foreground/70">• {e}</li>
                ))}
              </ul>
              <button onClick={() => setCsvErrors([])} className="font-mono text-[10px] uppercase text-foreground/40 hover:text-foreground mt-2">dismiss</button>
            </div>
          )}

          <div className="space-y-3">
            {questions.map((q, i) => (
              <QuestionEditor
                key={q.id}
                index={i}
                total={questions.length}
                question={q}
                quizDefaultTime={quiz.time_per_question}
                onChange={(patch) => updateQuestion(q.id, patch)}
                onDelete={() => deleteQuestion(q.id)}
                onMove={(dir) => moveQuestion(q.id, dir)}
              />
            ))}
            {questions.length === 0 && (
              <EmptyState
                eyebrow="Questions"
                title="Add your first question"
                body="Pick a question type above — multiple choice, true/false, numeric, ordering, image reveal, audio, map pin, text or open feedback. You can also import a CSV."
              />
            )}
          </div>
        </div>

        <div className="pt-8 border-t border-border">
          <button onClick={deleteQuiz} className="font-mono text-xs uppercase text-pink-shock hover:underline">
            Delete quiz
          </button>
        </div>
      </div>
    </HostShell>
  );
}

function QuestionEditor({ index, total, question, quizDefaultTime, onChange, onDelete, onMove }: {
  index: number;
  total: number;
  question: Question;
  quizDefaultTime: number;
  onChange: (patch: Partial<Question>) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [local, setLocal] = useState(question);
  useEffect(() => setLocal(question), [question.id, question.position]);

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

  function blurSave() { onChange(local); }

  function changeType(t: QuestionType) {
    if (t === "true_false") {
      const next = { ...local, question_type: t, options: ["TRUE", "FALSE"], correct_index: local.correct_index > 1 ? 0 : local.correct_index };
      setLocal(next);
      onChange({ question_type: t, options: next.options, correct_index: next.correct_index });
    } else if (t === "map_pin") {
      const next = { ...local, question_type: t, options: [], correct_index: -1,
        max_distance_km: local.max_distance_km ?? 5000,
        correct_lat: local.correct_lat ?? 0, correct_lng: local.correct_lng ?? 0 };
      setLocal(next);
      onChange({ question_type: t, options: [], correct_index: -1,
        max_distance_km: next.max_distance_km, correct_lat: next.correct_lat, correct_lng: next.correct_lng });
    } else if (t === "number") {
      const fmt = (local.options && local.options[0]) || "general";
      const next = { ...local, question_type: t, options: [fmt], correct_index: -1,
        correct_number: local.correct_number ?? 50,
        number_min: local.number_min ?? 0, number_max: local.number_max ?? 100,
        number_tolerance: local.number_tolerance ?? 10 };
      setLocal(next);
      onChange({ question_type: t, options: [fmt], correct_index: -1,
        correct_number: next.correct_number, number_min: next.number_min,
        number_max: next.number_max, number_tolerance: next.number_tolerance });
    } else if (t === "type") {
      const accepted = (local.accepted_answers && local.accepted_answers.length > 0)
        ? local.accepted_answers : [""];
      const next = { ...local, question_type: t, options: [], correct_index: -1, accepted_answers: accepted };
      setLocal(next);
      onChange({ question_type: t, options: [], correct_index: -1, accepted_answers: accepted });
    } else if (t === "feedback") {
      const placeholder = (local.options && local.options[0]) || "";
      const next = { ...local, question_type: t, options: [placeholder], correct_index: -1, accepted_answers: null };
      setLocal(next);
      onChange({ question_type: t, options: [placeholder], correct_index: -1, accepted_answers: null });
    } else if (t === "ordering") {
      const opts = (local.options && local.options.length >= 2 && !["true_false","map_pin","number","type","feedback"].includes(local.question_type))
        ? local.options : ["First", "Second", "Third", "Fourth"];
      const next = { ...local, question_type: t, options: opts, correct_index: -1, accepted_answers: null };
      setLocal(next);
      onChange({ question_type: t, options: opts, correct_index: -1, accepted_answers: null });
    } else if (t === "image_reveal") {
      const opts = (local.options && local.options.length >= 2 && !["true_false","map_pin","number","type","feedback"].includes(local.question_type))
        ? local.options : ["Option A", "Option B", "Option C", "Option D"];
      const ci = local.correct_index < 0 ? 0 : Math.min(local.correct_index, opts.length - 1);
      const stages = local.reveal_stages ?? 5;
      const next = { ...local, question_type: t, options: opts, correct_index: ci, reveal_stages: stages };
      setLocal(next);
      onChange({ question_type: t, options: opts, correct_index: ci, reveal_stages: stages });
    } else {
      const opts = (local.question_type === "true_false" || local.question_type === "map_pin" || local.question_type === "number" || local.question_type === "type" || local.question_type === "feedback")
        ? ["Option A", "Option B", "Option C", "Option D"] : local.options;
      const ci = local.correct_index < 0 ? 0 : local.correct_index;
      const next = { ...local, question_type: t, options: opts, correct_index: ci };
      setLocal(next);
      onChange({ question_type: t, options: opts, correct_index: ci });
    }
  }

  async function uploadImage(file: File) {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${local.id}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("quiz-images").upload(path, file, { upsert: true, contentType: file.type });
    if (error) { toast.error("Upload failed: " + error.message); return; }
    const { data: signed, error: sErr } = await supabase.storage.from("quiz-images").createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
    if (sErr || !signed?.signedUrl) { toast.error("Couldn't get image URL"); return; }
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
    const { error } = await supabase.storage.from("quiz-images").upload(path, file, { upsert: true, contentType: file.type });
    if (error) { toast.error("Upload failed: " + error.message); return; }
    const { data: signed, error: sErr } = await supabase.storage.from("quiz-images").createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
    if (sErr || !signed?.signedUrl) { toast.error("Couldn't get audio URL"); return; }
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
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="font-display text-2xl italic text-volt">{String(index + 1).padStart(2, "0")}</span>
          <div className="flex flex-col">
            <button onClick={() => onMove(-1)} disabled={index === 0} className="font-mono text-[10px] text-foreground/40 hover:text-volt disabled:opacity-20" title="Move up">▲</button>
            <button onClick={() => onMove(1)} disabled={index === total - 1} className="font-mono text-[10px] text-foreground/40 hover:text-volt disabled:opacity-20" title="Move down">▼</button>
          </div>
        </div>
        <textarea
          value={local.text}
          onChange={(e) => setLocal({ ...local, text: e.target.value })}
          onBlur={blurSave}
          rows={2}
          className="flex-1 bg-background border border-border p-3 text-base focus:outline-none focus:border-volt"
        />
        <button onClick={onDelete} className="font-mono text-xs uppercase text-pink-shock hover:underline">Del</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase text-foreground/60">Type</span>
        {(["mcq", "true_false", "image_mcq", "image_reveal", "audio", "map_pin", "number", "type", "feedback", "ordering"] as QuestionType[]).map((t) => (
          <button key={t} type="button" onClick={() => changeType(t)}
            className={`font-mono text-[10px] uppercase px-2 py-1 border ${local.question_type === t ? "border-volt bg-volt/10 text-volt" : "border-border text-foreground/60 hover:border-volt/60"}`}>
            {t === "mcq" ? "Multiple choice" : t === "true_false" ? "True / False" : t === "image_mcq" ? "Image MCQ" : t === "image_reveal" ? "🖼️ Image Reveal" : t === "audio" ? "🎧 Audio" : t === "map_pin" ? "📍 Map pin" : t === "number" ? "🎯 Closest number" : t === "type" ? "⌨️ Type answer" : t === "ordering" ? "🔀 Ordering" : "💬 Open feedback"}
          </button>
        ))}
        <label className={`font-mono text-[10px] uppercase px-2 py-1 border cursor-pointer ml-auto ${local.double_points ? "border-amber-spark bg-amber-spark/10 text-amber-spark" : "border-border text-foreground/60 hover:border-amber-spark/60"}`}>
          <input type="checkbox" checked={local.double_points} className="hidden"
            onChange={(e) => { setLocal({ ...local, double_points: e.target.checked }); onChange({ double_points: e.target.checked }); }} />
          ⚡ Double points
        </label>
      </div>

      {isMap && (
        <div className="border border-border p-3 space-y-3 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">📍 Correct location — click on the map</p>
          <MapPicker
            height={300}
            guess={local.correct_lat != null && local.correct_lng != null ? { lat: Number(local.correct_lat), lng: Number(local.correct_lng) } : null}
            onPick={(lat, lng) => { const next = { ...local, correct_lat: lat, correct_lng: lng }; setLocal(next); onChange({ correct_lat: lat, correct_lng: lng }); }}
          />
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Latitude</span>
              <input type="number" step="0.0001" value={local.correct_lat ?? ""} onChange={(e) => setLocal({ ...local, correct_lat: e.target.value === "" ? null : parseFloat(e.target.value) })} onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt" />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Longitude</span>
              <input type="number" step="0.0001" value={local.correct_lng ?? ""} onChange={(e) => setLocal({ ...local, correct_lng: e.target.value === "" ? null : parseFloat(e.target.value) })} onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt" />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Max dist (km)</span>
              <input type="number" min={10} step="10" value={local.max_distance_km ?? 5000} onChange={(e) => setLocal({ ...local, max_distance_km: parseFloat(e.target.value) || 5000 })} onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt" />
            </label>
          </div>
          <p className="font-mono text-[10px] text-foreground/40">Guesses within max distance earn points on a linear falloff; closer = more.</p>
        </div>
      )}

      {isNum && (() => {
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
          <p className="font-mono text-[10px] uppercase text-foreground/60">🎯 Numeric answer</p>
          <label className="space-y-1 block">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Answer format</span>
            <select value={numFormat} onChange={(e) => setFormat(e.target.value)}
              className="w-full bg-background border border-border p-2 font-mono text-xs focus:outline-none focus:border-volt">
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
                  onChange={(e) => setLocal({ ...local, correct_number: parseVal(e.target.value) })}
                  onBlur={blurSave}
                  placeholder={isYear ? "e.g. 1976" : isPct ? "e.g. 42.5" : ""}
                  className={`w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt ${isPct ? "pr-6" : ""}`}
                />
                {isPct && <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-xs text-foreground/60">%</span>}
              </div>
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Tolerance (± full pts)</span>
              <input type="number" min={0} step={step} placeholder="auto" value={local.number_tolerance ?? ""} onChange={(e) => { const raw = e.target.value; if (raw === "") { setLocal({ ...local, number_tolerance: null }); return; } const n = parseFloat(raw); setLocal({ ...local, number_tolerance: isYear || numFormat === "general" ? Math.trunc(n) : n }); }} onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt" />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Slider min</span>
              <input type="number" step={step} value={local.number_min ?? ""} onChange={(e) => setLocal({ ...local, number_min: e.target.value === "" ? null : parseFloat(e.target.value) })} onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt" />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Slider max</span>
              <input type="number" step={step} value={local.number_max ?? ""} onChange={(e) => setLocal({ ...local, number_max: e.target.value === "" ? null : parseFloat(e.target.value) })} onBlur={blurSave}
                className="w-full bg-background border border-border p-2 font-mono text-sm focus:outline-none focus:border-volt" />
            </label>
          </div>
          <p className="font-mono text-[10px] text-foreground/40">Points scale linearly from full (exact) to zero (at ± tolerance). Speed still matters.</p>
        </div>
        );
      })()}

      {isType && (
        <div className="border border-border p-3 space-y-3 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">⌨️ Accepted answers — case &amp; punctuation insensitive</p>
          <div className="space-y-2">
            {(local.accepted_answers ?? [""]).map((ans, i) => (
              <div key={i} className="flex items-center gap-2 border border-border bg-background">
                <span className="size-10 grid place-items-center shrink-0 font-mono text-xs text-foreground/40">{i === 0 ? "★" : "≈"}</span>
                <input
                  value={ans}
                  onChange={(e) => setAcceptedAnswer(i, e.target.value)}
                  onBlur={blurSave}
                  placeholder={i === 0 ? "Primary answer (e.g. George Washington)" : "Alternate (e.g. Washington)"}
                  className="flex-1 bg-transparent py-2 px-1 text-sm focus:outline-none"
                />
                {(local.accepted_answers ?? []).length > 1 && (
                  <button onClick={() => removeAcceptedAnswer(i)} className="px-2 font-mono text-xs text-foreground/40 hover:text-pink-shock">×</button>
                )}
              </div>
            ))}
            <button onClick={addAcceptedAnswer} className="font-mono text-xs uppercase text-foreground/60 hover:text-volt text-left py-1">
              + Add alternate answer
            </button>
          </div>
          <p className="font-mono text-[10px] text-foreground/40">First entry is the "official" answer shown at reveal. All entries match case-insensitively and ignore punctuation / extra whitespace.</p>
        </div>
      )}

      {isFeedback && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">💬 Open feedback — no correct answer, no scoring</p>
          <label className="space-y-1 block">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Input placeholder (optional)</span>
            <input
              value={(local.options && local.options[0]) || ""}
              onChange={(e) => setLocal({ ...local, options: [e.target.value] })}
              onBlur={() => onChange({ options: local.options })}
              placeholder="e.g. What would you like to see next time?"
              className="w-full bg-background border border-border p-2 text-sm focus:outline-none focus:border-volt"
            />
          </label>
          <p className="font-mono text-[10px] text-foreground/40">Responses are collected and shown to the host, grouped by frequency. No points, no streaks, no leaderboard impact.</p>
        </div>
      )}



      {(local.question_type === "image_mcq" || isReveal || local.image_url) && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">{isReveal ? "🖼️ Reveal image (required)" : "Image"}</p>
          {local.image_url && (
            <div className="relative">
              <img src={local.image_url} alt="" className="max-h-48 w-auto border border-border" />
              <button onClick={clearImage} className="absolute top-1 right-1 bg-background/80 border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-pink-shock hover:bg-pink-shock/10">Remove</button>
            </div>
          )}
          <label className="border border-border px-3 py-2 font-mono text-[10px] uppercase cursor-pointer hover:border-volt hover:text-volt inline-block">
            {local.image_url ? "Replace image" : "Upload image"}
            <input type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ""; }} />
          </label>
        </div>
      )}

      {isReveal && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">🖼️ Image reveal — image starts blurred and sharpens over the round</p>
          <label className="space-y-1 block max-w-[220px]">
            <span className="font-mono text-[10px] uppercase text-foreground/60">Reveal stages (2–10)</span>
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
          <p className="font-mono text-[10px] text-foreground/40">Reveal duration = time limit (below). Faster correct answers earn more points via the existing speed bonus.</p>
        </div>
      )}

      {isAudio && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">🎧 Audio clip (required) — autoplays once when the round starts, no replay</p>
          {local.audio_url && (
            <div className="flex items-center gap-2">
              <audio controls src={local.audio_url} className="w-full max-w-md" />
              <button onClick={clearAudio} className="border border-border px-2 py-1 font-mono text-[10px] uppercase text-pink-shock hover:bg-pink-shock/10">Remove</button>
            </div>
          )}
          <label className="border border-border px-3 py-2 font-mono text-[10px] uppercase cursor-pointer hover:border-volt hover:text-volt inline-block">
            {local.audio_url ? "Replace audio" : "Upload audio (mp3, wav, m4a, ogg)"}
            <input type="file" accept="audio/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAudio(f); e.target.value = ""; }} />
          </label>
          <p className="font-mono text-[10px] text-foreground/40">Faster correct answers earn more via the existing speed bonus.</p>
        </div>
      )}


      {isOrdering && (
        <div className="border border-border p-3 space-y-2 bg-background/40">
          <p className="font-mono text-[10px] uppercase text-foreground/60">🔀 Ordering — list items top→bottom in the correct order. Players see them shuffled and drag to reorder.</p>
          <div className="space-y-2">
            {local.options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2 border border-border bg-background">
                <span className="size-10 grid place-items-center shrink-0 font-mono text-xs text-volt bg-volt/10">{i + 1}</span>
                <input
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value)}
                  onBlur={blurSave}
                  placeholder={`Item ${i + 1}`}
                  className="flex-1 bg-transparent py-2 px-1 text-sm focus:outline-none"
                />
                <button type="button" onClick={() => {
                  if (i === 0) return;
                  const opts = [...local.options]; [opts[i - 1], opts[i]] = [opts[i], opts[i - 1]];
                  setLocal({ ...local, options: opts }); onChange({ options: opts });
                }} disabled={i === 0} className="px-2 font-mono text-xs text-foreground/40 hover:text-volt disabled:opacity-20">▲</button>
                <button type="button" onClick={() => {
                  if (i === local.options.length - 1) return;
                  const opts = [...local.options]; [opts[i + 1], opts[i]] = [opts[i], opts[i + 1]];
                  setLocal({ ...local, options: opts }); onChange({ options: opts });
                }} disabled={i === local.options.length - 1} className="px-2 font-mono text-xs text-foreground/40 hover:text-volt disabled:opacity-20">▼</button>
                {local.options.length > 2 && (
                  <button onClick={() => removeOption(i)} className="px-2 font-mono text-xs text-foreground/40 hover:text-pink-shock">×</button>
                )}
              </div>
            ))}
            {local.options.length < 8 && (
              <button onClick={addOption} className="font-mono text-xs uppercase text-foreground/60 hover:text-volt text-left py-1">
                + Add item
              </button>
            )}
          </div>
          <p className="font-mono text-[10px] text-foreground/40">Partial credit: points scale with how many items are placed correctly. Full order = full points + speed bonus.</p>
        </div>
      )}

      {isMap || isNum || isType || isFeedback || isOrdering ? null : isTF ? (
        <div className="grid grid-cols-2 gap-2">
          {["TRUE", "FALSE"].map((label, i) => (
            <button key={i} type="button"
              onClick={() => { setLocal({ ...local, correct_index: i }); onChange({ correct_index: i }); }}
              className={`p-4 border-2 font-display text-xl italic ${local.correct_index === i ? (i === 0 ? "border-volt bg-volt/10 text-volt" : "border-pink-shock bg-pink-shock/10 text-pink-shock") : "border-border text-foreground/60 hover:border-foreground/40"}`}>
              {local.correct_index === i ? "✓ " : ""}{label}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          {local.options.map((opt, i) => (
            <div key={i} className={`flex items-center gap-2 border ${local.correct_index === i ? "border-volt bg-volt/5" : "border-border"}`}>
              <button
                type="button"
                onClick={() => { setLocal({ ...local, correct_index: i }); onChange({ correct_index: i }); }}
                className={`size-10 grid place-items-center shrink-0 font-mono text-xs ${local.correct_index === i ? "bg-volt text-background" : "text-foreground/40 hover:text-volt"}`}
                title="Mark correct"
              >
                {local.correct_index === i ? "✓" : ["A","B","C","D","E","F"][i]}
              </button>
              <input
                value={opt}
                onChange={(e) => setOption(i, e.target.value)}
                onBlur={blurSave}
                className="flex-1 bg-transparent py-2 px-1 text-sm focus:outline-none"
              />
              {local.options.length > 2 && (
                <button onClick={() => removeOption(i)} className="px-2 font-mono text-xs text-foreground/40 hover:text-pink-shock">×</button>
              )}
            </div>
          ))}
          {local.options.length < 6 && (
            <button onClick={addOption} className="font-mono text-xs uppercase text-foreground/60 hover:text-volt text-left py-1">
              + Add option
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
        <label className="space-y-1">
          <span className="font-mono text-[10px] uppercase text-foreground/60">Time limit (sec)</span>
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

function CsvButton({ onImport }: { onImport: (text: string) => void }) {
  return (
    <label className="border border-border px-4 py-2.5 font-mono text-xs uppercase cursor-pointer hover:border-volt hover:text-volt">
      Import CSV
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          f.text().then(onImport).catch((err) => toast.error("Couldn't read file: " + (err?.message ?? err)));
          e.target.value = "";
        }}
      />
    </label>
  );
}
