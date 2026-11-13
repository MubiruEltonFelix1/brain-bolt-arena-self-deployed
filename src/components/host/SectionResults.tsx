"use client";

// Phase 13 — Section-based results UI (reporting only).
//
// Renders the section-performance overview and expandable section details for
// categorized completed sessions. All data is computed server-side by
// `getSessionResults` and derived from the immutable session snapshot, so the
// quiz may have been edited after the session without affecting this view.

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { type Metric } from "@/lib/result-presentation";
import { ParticipantSectionResult, QuestionReview, SectionResult } from "@/lib/quiz/results";

type SectionResultsProps = {
  sections: readonly SectionResult[];
  participantSections: readonly ParticipantSectionResult[];
  questions: readonly QuestionReview[];
  participants: readonly {
    id: string;
    nickname: string;
    score: number;
    avatar_id: string | null;
  }[];
};

type ScoredParticipant = ParticipantSectionResult & { nickname: string };

function formatAccuracy(m: Metric): string {
  return m.available ? `${m.value}%` : "—";
}

function formatPoints(n: number): string {
  return n.toLocaleString();
}

/** Renders the correct answer for a question, mirroring FinalReview's answer key. */
function correctAnswer(q: QuestionReview): React.ReactNode {
  if (q.questionType === "feedback") {
    return <p className="font-mono text-xs text-cyan-jolt">💬 Open feedback — no correct answer</p>;
  }
  if (q.questionType === "true_false") {
    return (
      <p className="font-mono text-xs">
        <span className="text-foreground/40">CORRECT: </span>
        <span className="text-volt">{q.correctIndex === 0 ? "TRUE" : "FALSE"}</span>
      </p>
    );
  }
  if (q.questionType === "map_pin") {
    const label = q.geoRegionLabel ?? "—";
    return (
      <p className="font-mono text-xs">
        <span className="text-foreground/40">CORRECT: </span>
        <span className="text-volt">🗺️ {label}</span>
      </p>
    );
  }
  if (q.questionType === "number") {
    return (
      <p className="font-mono text-xs">
        <span className="text-foreground/40">CORRECT: </span>
        <span className="text-volt">
          🎯 {q.correctNumber != null ? q.correctNumber.toLocaleString() : "—"}
        </span>
      </p>
    );
  }
  if (q.questionType === "type") {
    return (
      <p className="font-mono text-xs">
        <span className="text-foreground/40">CORRECT: </span>
        <span className="text-volt">⌨️ {q.acceptedAnswers?.[0] ?? "—"}</span>
      </p>
    );
  }
  if (q.questionType === "ordering") {
    return (
      <p className="font-mono text-xs">
        <span className="text-foreground/40">CORRECT: </span>
        <span className="text-volt">🔀 {q.options.join(" → ")}</span>
      </p>
    );
  }
  return (
    <p className="font-mono text-xs">
      <span className="text-foreground/40">CORRECT: </span>
      <span className="text-volt">{q.options[q.correctIndex] ?? "—"}</span>
    </p>
  );
}

/** One question's review row inside an expanded section. */
function QuestionReviewRow({ q }: { q: QuestionReview }): React.ReactNode {
  const isChoice = q.questionType === "mcq" || q.questionType === "true_false";
  const total = q.correct + q.incorrect;

  return (
    <div key={q.id} className="border border-border p-4 rounded-md bg-background/30">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-foreground/40">
            Q{q.questionType === "feedback" ? "FB" : q.id.slice(-4)}
          </span>
          {q.doublePoints && (
            <span className="font-mono text-xs uppercase text-amber-spark">⚡ double points</span>
          )}
        </div>
      </div>
      <p className="font-medium text-sm mb-3">{q.text}</p>
      {correctAnswer(q)}
      <div className="border-t border-border pt-3 mt-3 space-y-1">
        <div className="flex items-center justify-between text-[10px] uppercase text-foreground/60">
          <span>Responses</span>
          <span className="font-mono tabular-nums">{total}</span>
        </div>
        {isChoice && q.options.length > 0 ? (
          <div className="mt-1 space-y-0.5">
            {q.options.map((opt, i) => {
              const count = i === q.correctIndex ? q.correct : q.incorrect;
              // For choice questions we can't split correct/incorrect per option from
              // the stored aggregates; show the option's share of answered responses.
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              const isCorrect = i === q.correctIndex;
              return (
                <div
                  key={i}
                  className={`border ${isCorrect ? "border-volt" : "border-border"} p-2`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`font-medium text-sm ${isCorrect ? "text-volt" : ""}`}>
                      {isCorrect ? "✓ " : ""}
                      {q.questionType === "true_false"
                        ? opt
                        : `${["A", "B", "C", "D", "E", "F"][i]} — ${opt}`}
                    </span>
                    <span className="font-mono text-xs text-foreground/70">
                      {count} ({pct}%)
                    </span>
                  </div>
                  <div className="h-1.5 bg-border rounded-full overflow-hidden">
                    <div
                      className={isCorrect ? "bg-volt" : "bg-cyan-jolt/60"}
                      style={{ width: `${pct}%`, height: "100%" }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 mt-1 text-[10px] uppercase text-foreground/60">
            <div className="p-1.5 bg-background/40 rounded-md">
              <span className="block font-mono text-xs text-volt">{q.correct}</span>
              <span className="block font-mono text-[10px] text-foreground/50">correct</span>
            </div>
            <div className="p-1.5 bg-background/40 rounded-md">
              <span className="block font-mono text-xs text-pink-shock">{q.incorrect}</span>
              <span className="block font-mono text-[10px] text-foreground/50">incorrect</span>
            </div>
            <div className="p-1.5 bg-background/40 rounded-md">
              <span className="block font-mono text-xs text-foreground">
                {q.unanswered > 0 ? q.unanswered : 0}
              </span>
              <span className="block font-mono text-[10px] text-foreground/50">unanswered</span>
            </div>
            <div className="p-1.5 bg-background/40 rounded-md">
              <span className="block font-mono text-xs text-volt">
                {formatPoints(q.pointsEarned)}
              </span>
              <span className="block font-mono text-[10px] text-foreground/50">points</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Per-section participant breakdown. */
function SectionParticipantTable({
  sectionId,
  participants,
}: {
  sectionId: string;
  participants: readonly ScoredParticipant[];
}): React.ReactNode {
  const rows = participants.filter((p) => p.sectionId === sectionId);
  if (rows.length === 0) return null;

  return (
    <div className="mt-6 border border-border rounded-md bg-background overflow-hidden">
      <div className="border-b border-border bg-background/40 px-3 py-2 font-mono text-[10px] uppercase text-foreground/60 grid grid-cols-[1fr_60px_60px_60px_70px_60px]">
        <span>Player</span>
        <span className="text-right">Answered</span>
        <span className="text-right">Correct</span>
        <span className="text-right">Incorrect</span>
        <span className="text-right">Accuracy</span>
        <span className="text-right">Points</span>
      </div>
      <div className="max-h-[320px] overflow-auto">
        {rows.map((p) => (
          <div
            key={p.participantId}
            className="border-b border-border/50 px-3 py-2 font-mono text-xs grid grid-cols-[1fr_60px_60px_60px_70px_60px] items-center gap-2 hover:bg-volt/5"
          >
            <span className="truncate">{p.nickname}</span>
            <span className="text-right tabular-nums">{p.answered}</span>
            <span className="text-right tabular-nums text-volt">{p.correct}</span>
            <span className="text-right tabular-nums text-pink-shock">{p.incorrect}</span>
            <span className="text-right">{formatAccuracy(p.accuracy)}</span>
            <span className="text-right tabular-nums text-volt italic">
              {formatPoints(p.pointsEarned)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Collapsible block for one section: header = compact summary, content = details. */
function SectionBlock({
  section,
  questions,
  participants,
  participantNicknames,
}: {
  section: SectionResult;
  questions: readonly QuestionReview[];
  participants: readonly ParticipantSectionResult[];
  participantNicknames: Record<string, string>;
}): React.ReactNode {
  const sectionQuestions = questions.filter((q) => section.questionIds.includes(q.id));
  const sectionParticipants = participants.filter((p) => p.sectionId === section.id);

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <div className="border border-border p-4 rounded-md bg-background flex items-center justify-between gap-3 group cursor-pointer hover:border-volt/50 transition-colors">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[10px] text-foreground/40">
                Section {section.position + 1}
              </span>
              {section.totalScoredQuestions === 0 && (
                <span className="font-mono text-[10px] text-foreground/50">empty</span>
              )}
            </div>
            <h3 className="font-display text-lg italic uppercase leading-snug">{section.title}</h3>
            <p className="font-mono text-xs text-foreground/60">
              {section.totalScoredQuestions} scored question
              {section.totalScoredQuestions === 1 ? "" : "s"}
            </p>
          </div>
          <div className="text-right space-y-0.5">
            <div className="font-display text-xl italic text-volt tabular-nums">
              {formatPoints(section.pointsEarned)}
            </div>
            <div className="font-mono text-xs text-foreground/60">
              {formatAccuracy(section.accuracy)} accuracy
            </div>
            <div className="font-mono text-[10px] text-foreground/50">
              {section.totalCorrect} correct · {section.totalIncorrect} incorrect
            </div>
          </div>
          <button
            aria-label={`Expand ${section.title}`}
            className="size-6 rounded border border-border flex items-center justify-center group-hover:bg-volt/10 transition-colors"
          >
            <span className="text-[10px] text-foreground/40 group-hover:text-volt">Expand</span>
          </button>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4">
        {section.totalScoredQuestions === 0 ? (
          <div className="border border-dashed border-border/50 rounded-md p-6 text-center text-foreground/50">
            <p className="font-mono text-xs uppercase">This section had no questions.</p>
          </div>
        ) : (
          <>
            <div className="border border-border p-3 rounded-md bg-background/40 grid grid-cols-4 gap-2 text-[10px] uppercase text-foreground/60">
              <div className="p-1 bg-background rounded">
                <span className="block font-display text-xl italic text-volt tabular-nums">
                  {section.totalScoredQuestions}
                </span>
                <span className="block font-mono text-[10px] text-foreground/50">scored</span>
              </div>
              <div className="p-1 bg-background rounded">
                <span className="block font-display text-xl italic text-volt tabular-nums">
                  {section.totalAnswers}
                </span>
                <span className="block font-mono text-[10px] text-foreground/50">answered</span>
              </div>
              <div className="p-1 bg-background rounded">
                <span className="block font-display text-xl italic text-volt tabular-nums">
                  {section.totalCorrect}
                </span>
                <span className="block font-mono text-[10px] text-foreground/50">correct</span>
              </div>
              <div className="p-1 bg-background rounded">
                <span className="block font-display text-xl italic text-pink-shock tabular-nums">
                  {section.totalIncorrect}
                </span>
                <span className="block font-mono text-[10px] text-foreground/50">incorrect</span>
              </div>
            </div>

            <div className="space-y-2">
              <p className="font-mono text-[10px] uppercase text-foreground/60">Question review</p>
              {sectionQuestions.length === 0 ? (
                <p className="font-mono text-xs text-foreground/50">No questions to review.</p>
              ) : (
                <div className="space-y-2">
                  {sectionQuestions.map((q) => (
                    <QuestionReviewRow key={q.id} q={q} />
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
                Participants in this section
              </p>
              <SectionParticipantTable
                sectionId={section.id}
                participants={
                  sectionParticipants.map((p) => ({
                    ...p,
                    nickname: participantNicknames[p.participantId] ?? "Player",
                  })) as unknown as readonly ScoredParticipant[]
                }
              />
            </div>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Participant performance across all sections (matrix view). */
function ParticipantMatrix({
  participants,
  participantSections,
  sections,
}: {
  participants: readonly {
    id: string;
    nickname: string;
    score: number;
    avatar_id: string | null;
  }[];
  participantSections: readonly ParticipantSectionResult[];
  sections: readonly SectionResult[];
}): React.ReactNode {
  if (participants.length === 0 || sections.length === 0) return null;

  const byParticipant = new Map<string, ParticipantSectionResult[]>();
  for (const ps of participantSections) {
    const list = byParticipant.get(ps.participantId) ?? [];
    list.push(ps);
    byParticipant.set(ps.participantId, list);
  }

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <div className="border border-border p-4 rounded-md bg-background flex items-center justify-between gap-3 group cursor-pointer hover:border-volt/50 transition-colors">
          <div>
            <span className="font-mono text-[10px] text-foreground/40 block mb-1">
              Participant performance
            </span>
            <h3 className="font-display text-lg italic uppercase">By section</h3>
          </div>
          <div className="text-right">
            <span className="font-mono text-[10px] text-foreground/60">
              {participants.length} participant{participants.length === 1 ? "" : "s"}
            </span>
          </div>
          <button
            aria-label="Expand participant matrix"
            className="size-6 rounded border border-border flex items-center justify-center group-hover:bg-volt/10 transition-colors"
          >
            <span className="text-[10px] text-foreground/40 group-hover:text-volt">Expand</span>
          </button>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">
        <div className="overflow-auto border border-border rounded-md bg-background">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-background/40">
                <th className="px-3 py-2 font-mono text-[10px] uppercase text-foreground/60">
                  Player
                </th>
                {sections.map((s) => (
                  <th
                    key={s.id}
                    className="px-3 py-2 font-mono text-[10px] uppercase text-foreground/60 text-right truncate"
                    title={s.title}
                  >
                    {s.title}
                  </th>
                ))}
                <th className="px-3 py-2 font-mono text-[10px] uppercase text-foreground/60 text-right">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => {
                const rows = byParticipant.get(p.id) ?? [];
                const bySection = new Map(rows.map((r) => [r.sectionId, r]));
                let totalPoints = 0;
                return (
                  <tr
                    key={p.id}
                    className="border-b border-border/50 font-mono text-xs hover:bg-volt/5"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PlayerAvatar avatarId={p.avatar_id} seed={p.id} size={18} />
                        <span className="truncate">{p.nickname}</span>
                      </div>
                    </td>
                    {sections.map((s) => {
                      const r = bySection.get(s.id);
                      totalPoints += r?.pointsEarned ?? 0;
                      return (
                        <td key={s.id} className="px-3 py-2 text-right tabular-nums">
                          {r
                            ? `${formatPoints(r.pointsEarned)} · ${formatAccuracy(r.accuracy)}`
                            : "—"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-volt">
                      {formatPoints(totalPoints)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SectionResults(props: SectionResultsProps): React.ReactNode {
  const { sections, participantSections, questions, participants } = props;

  if (sections.length === 0) return null;

  const participantNicknames = Object.fromEntries(participants.map((p) => [p.id, p.nickname]));

  return (
    <div className="space-y-6">
      <div className="border border-border p-4 rounded-md bg-background/40">
        <p className="font-mono text-[10px] uppercase text-foreground/60 mb-2">
          Section performance — from the session snapshot
        </p>
        <p className="font-mono text-xs text-foreground/50">
          Section titles, order and question membership are taken from the immutable snapshot
          captured when the session started. Editing the quiz afterward does not change these
          results.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sections.map((section) => (
          <SectionBlock
            key={section.id}
            section={section}
            questions={questions}
            participants={participantSections}
            participantNicknames={participantNicknames}
          />
        ))}
      </div>

      <ParticipantMatrix
        participants={participants}
        participantSections={participantSections}
        sections={sections}
      />
    </div>
  );
}
