// Brain Bolt — unified quiz creation entry point.
//
// One coherent workflow: Source → Quiz Brief → Preparation → Review → Quiz Editor.
//
// Entry options:
//   * Blank Quiz — create an empty quiz and open the editor (replaces "+ NEW QUIZ")
//   * From a Topic — topic text + brief config → topic-based prep job → /create/$jobId
//   * From Material — document upload → existing /prep/new flow (unchanged)
//   * From Existing Questions — deferred (Question Bank not yet implemented)
//
// Hosts never need to create an empty quiz before starting. The quiz is
// created implicitly when the draft is published to /quizzes/$id.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useAuthUser } from "@/hooks/use-auth-user";
import { getQuestionType } from "@/lib/question-registry";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { prepCreateTopicJob } from "@/lib/api/prep-topic.functions";
import { prepSetBlueprint } from "@/lib/api/prep.functions";
import { toastError } from "@/lib/errors";

export const Route = createFileRoute("/create")({
  component: CreateQuiz,
});

type Difficulty = "easy" | "medium" | "hard";

type Brief = {
  title: string;
  difficulty: Difficulty;
  questionCount: number;
  types: string[];
  instructions: string;
};

const DEFAULT_BRIEF: Brief = {
  title: "",
  difficulty: "medium",
  questionCount: 5,
  types: ["mcq", "true_false"],
  instructions: "",
};

const SOURCE_TYPES = {
  blank: {
    id: "blank" as const,
    label: "Blank Quiz",
    description:
      "Create an empty quiz and add questions yourself in the editor.",
    icon: "📝",
  },
  topic: {
    id: "topic" as const,
    label: "From a Topic",
    description:
      "Describe what the quiz should cover. Brain Bolt AI drafts questions from the topic.",
    icon: "💡",
  },
  material: {
    id: "material" as const,
    label: "From Material",
    description:
      "Upload a PDF or image. Brain Bolt reads it and drafts source-grounded questions.",
    icon: "📄",
  },
  bank: {
    id: "bank" as const,
    label: "From Existing Questions",
    description: "Build from your Question Bank. (Coming soon — not yet implemented.)",
    icon: "🏦",
    disabled: true,
  },
} as const;

const ALL_TYPES = ["mcq", "true_false", "number", "type", "ordering", "feedback", "map_pin"];

function CreateQuiz() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"blank" | "topic" | "material" | "bank" | null>(null);
  const [brief, setBrief] = useState<Brief>({ ...DEFAULT_BRIEF });
  const [topic, setTopic] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!user) {
    return (
      <HostShell>
        <div className="max-w-3xl mx-auto px-6 py-10 space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">Sign in</p>
          <p className="text-foreground/70">Sign in to create a quiz with AI preparation.</p>
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

  const updateBrief = useCallback(
    (patch: Partial<Brief>) => {
      setBrief((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  // Open the brief dialog whenever a source is selected.
  useEffect(() => {
    if (source) setDialogOpen(true);
  }, [source]);

  const toggleType = useCallback((t: string) => {
    setBrief((prev) => ({
      ...prev,
      types: prev.types.includes(t) ? prev.types.filter((x) => x !== t) : [...prev.types, t],
    }));
  }, []);

  async function startTopicPrep() {
    if (!topic.trim()) {
      setUploadError("Enter a topic for the quiz.");
      return;
    }
    if (brief.types.length === 0) {
      setUploadError("Pick at least one question type.");
      return;
    }
    setCreating(true);
    setUploadError(null);
    try {
      const started = await prepCreateTopicJob({
        data: { topic: topic.trim() },
      });
      if (started.error || !started.jobId) {
        setUploadError(
          started.error === "not_authorized"
            ? "You're not allowed to start a preparation job."
            : started.error === "over_limit"
              ? "AI preparation is temporarily unavailable."
            : "Couldn't start the preparation. Try again.",
        );
        return;
      }

      // Save the quiz brief (blueprint) on the job.
      const confirmed = await prepSetBlueprint({
        data: {
          jobId: started.jobId,
          title: brief.title || "Quiz",
          difficulty: brief.difficulty,
          questionCount: brief.questionCount,
          types: brief.types as any,
          includedPageNumbers: [1], // topic-based: single synthetic source
          instructions: brief.instructions || undefined,
        },
      });
      if (confirmed.error) {
        setUploadError(
          confirmed.error === "not_authorized"
            ? "You're not allowed to configure this quiz."
            : "Couldn't save the quiz brief. Try again.",
        );
        return;
      }

      setDialogOpen(false);
      navigate({ to: `/create/$jobId`, params: { jobId: started.jobId } });
    } catch (e) {
      console.error("[create/topic] failed", e);
      setUploadError("Couldn't start the preparation. Try again.");
    } finally {
      setCreating(false);
    }
  }

  function startMaterialPrep() {
    if (!file) {
      setUploadError("Choose a PDF or image to upload.");
      return;
    }
    // Documents go through the existing /prep/new flow, which handles
    // signed upload, validation, extraction, OCR, and content mapping.
    // The brief is configured on the job page at the host_blueprint stage.
    setDialogOpen(false);
    navigate({ to: "/prep/new" });
  }

  async function startBlankQuiz() {
    if (!brief.title) {
      setUploadError("Give your quiz a title first.");
      return;
    }
    setCreating(true);
    setUploadError(null);
    try {
      const { data, error } = await supabase
        .from("quizzes")
        .insert({ owner_principal_id: user!.id, title: brief.title } as never)
        .select("id")
        .single();
      if (error || !data) {
        setUploadError("Couldn't create the quiz. Try again.");
        return;
      }
      setDialogOpen(false);
      navigate({ to: `/quizzes/${data.id}` });
    } catch (e) {
      console.error("[create/blank] failed", e);
      setUploadError("Couldn't create the quiz. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <HostShell title="Create a Quiz">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-12">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-volt">
            ✦ Create a Quiz
          </p>
          <h1 className="font-display text-5xl italic uppercase mt-1">
            New quiz preparation
          </h1>
          <p className="mt-2 text-foreground/60">
            Choose how you&rsquo;d like to build the quiz. Brain Bolt AI drafts
            the questions; you review and approve them before they go live.
          </p>
        </div>

        {/* Step 1: Source selection */}
        <div className="border border-border bg-card/40 p-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50 mb-4 block">
            01 · Source
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {Object.values(SOURCE_TYPES).map((s) => {
              const selected = source === s.id;
              const isDisabled = (s as { disabled?: boolean }).disabled === true;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={isDisabled}
                  onClick={isDisabled ? undefined : () => setSource(s.id)}
                  className={`flex flex-col items-center gap-3 p-5 border rounded-sm transition-colors ${
                    selected
                      ? "border-volt bg-volt/5"
                      : "border-border hover:border-foreground/40"
                  } ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <div className="size-14 grid place-items-center bg-background/30 rounded border border-border/40 mb-2">
                    <span className="text-2xl">{s.icon}</span>
                  </div>
                  <p className="font-display text-xl italic uppercase text-foreground">
                    {s.label}
                  </p>
                  <p className="text-[11px] text-foreground/60 leading-snug text-center">
                    {s.description}
                  </p>
                  {isDisabled && (
                    <span className="mt-2 font-mono text-[9px] uppercase text-pink-shock">
                      Coming soon
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2: Quiz Brief (overlay dialog) */}
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false);
            setSource(null);
            setUploadError(null);
            setBrief({ ...DEFAULT_BRIEF });
            setTopic("");
            setFile(null);
          } else {
            setDialogOpen(true);
          }
        }}>
          <DialogTrigger asChild>
            <button type="button" style={{ display: "none" }} />
          </DialogTrigger>
          <DialogContent className="flex flex-col max-h-[88vh]">
            <DialogHeader>
              <DialogTitle>
                {source === "blank" ? "New Blank Quiz" : source === "topic" ? "New Topic Quiz" : "New Material Quiz"}
              </DialogTitle>
              <DialogDescription>
                Configure the quiz before preparation starts.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto space-y-4 py-2">
              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase text-foreground/60">
                  Quiz title
                </label>
                <input
                  value={brief.title}
                  onChange={(e) => updateBrief({ title: e.target.value })}
                  placeholder="e.g. Genetics 101"
                  className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                  autoFocus
                />
              </div>

              {source === "topic" && (
                <>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60 block">
                      Topic
                    </label>
                    <textarea
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      rows={3}
                      placeholder="e.g. Mendelian inheritance, Punnett squares, and genetic probability"
                      className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                    />
                  </div>
                </>
              )}

              {source === "material" && (
                <>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] uppercase text-foreground/60 block">
                      Source file (PDF, PNG, JPEG, WebP)
                    </label>
                    <div
                      className="border border-border bg-background/20 p-6 rounded cursor-pointer"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp"
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setFile(f);
                          setUploadError(null);
                        }}
                      />
                      {file ? (
                        <p className="font-mono text-xs uppercase text-foreground/70">
                          {file.name} · {((file.size / 1024 / 1024).toFixed(2))} MB
                        </p>
                      ) : (
                        <p className="font-mono text-xs uppercase text-foreground/60">
                          Choose file
                        </p>
                      )}
                    </div>
                    <p className="font-mono text-[9px] uppercase text-foreground/40">
                      The quiz brief is configured on the preparation page after upload.
                    </p>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase text-foreground/60">
                  Difficulty
                </label>
                <select
                  value={brief.difficulty}
                  onChange={(e) => updateBrief({ difficulty: e.target.value as Difficulty })}
                  className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase text-foreground/60">
                  Number of questions
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={brief.questionCount}
                  onChange={(e) =>
                    updateBrief({
                      questionCount: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                    })
                  }
                  className="w-full bg-background border border-border p-3 font-mono text-sm text-center focus:border-volt"
                />
              </div>

              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase text-foreground/60">
                  Question types
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {ALL_TYPES.map((t) => {
                    const isSelected = brief.types.includes(t);
                    return (
                      <label
                        key={t}
                        className={`flex items-center gap-2 p-3 border rounded-sm cursor-pointer transition-colors ${
                          isSelected
                            ? "border-volt text-volt bg-volt/5"
                            : "border-border text-foreground/70 hover:border-foreground/40"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleType(t)}
                          className="accent-volt"
                        />
                        <span className="font-mono text-[10px] uppercase">
                          {getQuestionType(t).label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <label className="font-mono text-[10px] uppercase text-foreground/60 block">
                  Additional instructions (optional, max 500 chars)
                </label>
                <textarea
                  value={brief.instructions}
                  onChange={(e) => updateBrief({ instructions: e.target.value.slice(0, 500) })}
                  rows={2}
                  placeholder="e.g. Focus on practical applications, not just theory."
                  className="w-full bg-background border border-border p-3 font-sans text-sm focus:border-volt"
                />
              </div>

              {uploadError && (
                <div className="border border-pink-shock/40 bg-pink-shock/5 p-4 font-mono text-xs uppercase text-pink-shock">
                  {uploadError}
                </div>
              )}
            </div>
            <DialogFooter>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="border border-border px-4 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
              >
                Cancel
              </button>
              {source === "blank" ? (
                <button
                  type="button"
                  onClick={startBlankQuiz}
                  disabled={creating || !brief.title || brief.types.length === 0}
                  className="bg-volt text-background font-display text-sm uppercase px-6 py-3 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {creating ? "Creating…" : "Create Empty Quiz"}
                </button>
              ) : source === "topic" ? (
                <button
                  type="button"
                  onClick={startTopicPrep}
                  disabled={
                    creating || !topic.trim() || brief.types.length === 0 || !brief.title
                  }
                  className="bg-volt text-background font-display text-sm uppercase px-6 py-3 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {creating ? "Starting…" : "Start Preparation"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startMaterialPrep}
                  disabled={!file || creating}
                  className="bg-volt text-background font-display text-sm uppercase px-6 py-3 skew-cta disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {creating ? "Uploading…" : "Start from Material"}
                </button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </HostShell>
  );
}
