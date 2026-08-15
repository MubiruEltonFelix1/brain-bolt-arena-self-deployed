import { useEffect, useMemo, useRef, useState } from "react";
import { OrderingBoard, type OrderingItem } from "@/components/OrderingBoard";
import { NumberGuess } from "@/components/NumberGuess";
import { MapPicker } from "@/components/MapPicker";
import { getQuestionType, soloRevealBlur } from "@/lib/question-registry";
import type { NumberFormat } from "@/lib/number-format";

/**
 * Surface-agnostic description of a question for the solo surfaces
 * (Arena + Training).
 *
 * It deliberately carries NO answer key: grading stays on the surface that
 * owns it (server for Arena, local dataset for Training), so this shape can
 * never leak a correct answer into a component that shouldn't have it.
 */
export type QuestionSpec = {
  id: string;
  type: string;
  prompt: string;
  /** Choices for choice types, items to arrange for ordering. */
  options: string[];
  imageUrl?: string | null;
  audioUrl?: string | null;
  revealStages?: number | null;
  number?: { min: number; max: number; format?: NumberFormat; unit?: string };
  textPlaceholder?: string;
};

/** What the player did. The surface decides what it means. */
export type SubmittedAnswer =
  | { kind: "choice"; index: number }
  | { kind: "order"; order: number[]; labels: string[] }
  | { kind: "geo"; lat: number; lng: number }
  | { kind: "number"; value: number }
  | { kind: "text"; text: string };

/* ---------------- Shared chrome ---------------- */

export function QuestionTimerBar({
  remainingMs,
  totalMs,
}: {
  remainingMs: number;
  totalMs: number;
}) {
  return (
    <div className="h-1 bg-border overflow-hidden">
      <div
        className="h-full bg-volt"
        style={{
          width: `${(remainingMs / Math.max(1, totalMs)) * 100}%`,
          transition: "width 200ms linear",
        }}
      />
    </div>
  );
}

/* ---------------- Renderer ---------------- */

/**
 * Renders the interactive body for any Brain Bolt question type on the solo
 * surfaces. Question type #10 only needs a registry entry plus a case here.
 */
export function QuestionRenderer({
  question,
  elapsedMs,
  timeLimitMs,
  disabled,
  onAnswer,
}: {
  question: QuestionSpec;
  elapsedMs: number;
  timeLimitMs: number;
  disabled?: boolean;
  onAnswer: (answer: SubmittedAnswer) => void;
}) {
  const def = getQuestionType(question.type);

  switch (def.answerKind) {
    case "order":
      return (
        <OrderingAnswer
          key={question.id}
          items={question.options}
          disabled={disabled}
          onAnswer={onAnswer}
        />
      );
    case "geo":
      return <GeoAnswer key={question.id} disabled={disabled} onAnswer={onAnswer} />;
    case "number":
      return (
        <NumberAnswer key={question.id} spec={question} disabled={disabled} onAnswer={onAnswer} />
      );
    case "text":
      return (
        <TextAnswer key={question.id} spec={question} disabled={disabled} onAnswer={onAnswer} />
      );
    case "choice":
    default:
      return (
        <div className="space-y-3">
          {def.media === "image_reveal" && question.imageUrl && (
            <RevealImage
              url={question.imageUrl}
              elapsedMs={elapsedMs}
              totalMs={timeLimitMs}
              stages={question.revealStages}
            />
          )}
          {def.media === "audio" && question.audioUrl && (
            <AudioAutoplay key={question.id} url={question.audioUrl} />
          )}
          {def.media !== "image_reveal" && question.imageUrl && (
            <div className="border border-border overflow-hidden bg-card aspect-video">
              <img src={question.imageUrl} alt={`Illustration for the question: ${question.prompt}`} className="w-full h-full object-cover" />
            </div>
          )}
          <ChoiceGrid
            choices={question.options}
            disabled={disabled}
            onPick={(i) => onAnswer({ kind: "choice", index: i })}
          />
        </div>
      );
  }
}

/* ---------------- Bodies ---------------- */

export function ChoiceGrid({
  choices,
  disabled,
  onPick,
}: {
  choices: string[];
  disabled?: boolean;
  onPick: (i: number) => void;
}) {
  const colors = [
    "bg-volt text-background",
    "bg-pink-shock text-background",
    "bg-cyan-jolt text-background",
    "bg-amber-spark text-background",
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {choices.map((c, i) => (
        <button
          key={i}
          disabled={disabled}
          onClick={() => onPick(i)}
          className={`p-4 font-display italic text-lg text-left uppercase active:scale-95 transition-transform disabled:opacity-50 ${colors[i % colors.length]}`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function RevealImage({
  url,
  elapsedMs,
  totalMs,
  stages,
}: {
  url: string;
  elapsedMs: number;
  totalMs: number;
  stages?: number | null;
}) {
  const { blurPx } = soloRevealBlur(elapsedMs, totalMs, stages);
  return (
    <div className="border border-border overflow-hidden bg-card aspect-video">
      <img
        src={url}
        alt="Progressively revealed image for this question"
        className="w-full h-full object-cover"
        style={{ filter: `blur(${blurPx}px)`, transition: "filter 400ms" }}
      />
    </div>
  );
}

export function AudioAutoplay({ url }: { url: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [needsTap, setNeedsTap] = useState(false);
  useEffect(() => {
    ref.current?.play().catch(() => setNeedsTap(true));
  }, [url]);
  return (
    <div className="p-4 border border-border bg-card flex items-center gap-3">
      <span className="text-2xl">🎧</span>
      <audio ref={ref} src={url} preload="auto" />
      <p className="flex-1 font-mono text-xs uppercase text-foreground/60">
        {needsTap ? "Tap to play" : "Playing…"}
      </p>
      {needsTap && (
        <button
          onClick={() =>
            ref.current
              ?.play()
              .then(() => setNeedsTap(false))
              .catch(() => {})
          }
          className="px-3 py-1 border border-volt text-volt font-mono text-xs uppercase"
        >
          Play
        </button>
      )}
    </div>
  );
}

function OrderingAnswer({
  items,
  disabled,
  onAnswer,
}: {
  items: string[];
  disabled?: boolean;
  onAnswer: (a: SubmittedAnswer) => void;
}) {
  const initial = useMemo<OrderingItem[]>(
    () => items.map((label, i) => ({ id: `${i}-${label}`, label })).sort(() => Math.random() - 0.5),
    [items],
  );
  const [order, setOrder] = useState(initial);
  return (
    <div className="space-y-3">
      <OrderingBoard items={order} onReorder={setOrder} disabled={disabled} />
      <button
        disabled={disabled}
        onClick={() =>
          onAnswer({
            kind: "order",
            order: order.map((it) => Number(it.id.split("-")[0])),
            labels: order.map((it) => it.label),
          })
        }
        className="w-full bg-volt text-background font-display text-lg py-3 skew-cta active:scale-95 transition-transform disabled:opacity-50"
      >
        LOCK IN
      </button>
    </div>
  );
}

function GeoAnswer({
  disabled,
  onAnswer,
}: {
  disabled?: boolean;
  onAnswer: (a: SubmittedAnswer) => void;
}) {
  const [guess, setGuess] = useState<{ lat: number; lng: number } | null>(null);
  return (
    <div className="space-y-3">
      <MapPicker guess={guess} onPick={(lat, lng) => setGuess({ lat, lng })} />
      <button
        disabled={!guess || disabled}
        onClick={() => guess && onAnswer({ kind: "geo", lat: guess.lat, lng: guess.lng })}
        className="w-full bg-volt text-background font-display text-lg py-3 skew-cta active:scale-95 transition-transform disabled:opacity-50"
      >
        {guess ? "LOCK IN PIN" : "TAP THE MAP"}
      </button>
    </div>
  );
}

function NumberAnswer({
  spec,
  disabled,
  onAnswer,
}: {
  spec: QuestionSpec;
  disabled?: boolean;
  onAnswer: (a: SubmittedAnswer) => void;
}) {
  const min = spec.number?.min ?? 0;
  const max = spec.number?.max ?? 100;
  const [val, setVal] = useState(Math.floor((min + max) / 2));
  return (
    <div className="space-y-4">
      <NumberGuess
        min={min}
        max={max}
        value={val}
        onChange={setVal}
        disabled={disabled}
        unit={spec.number?.unit}
        format={spec.number?.format ?? "general"}
      />
      <button
        disabled={disabled}
        onClick={() => onAnswer({ kind: "number", value: val })}
        className="w-full bg-volt text-background font-display text-lg py-3 skew-cta active:scale-95 transition-transform disabled:opacity-50"
      >
        LOCK IN
      </button>
    </div>
  );
}

function TextAnswer({
  spec,
  disabled,
  onAnswer,
}: {
  spec: QuestionSpec;
  disabled?: boolean;
  onAnswer: (a: SubmittedAnswer) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer({ kind: "text", text });
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        placeholder={spec.textPlaceholder ?? "TYPE YOUR ANSWER"}
        className="w-full bg-card border-2 border-border py-4 px-5 text-xl font-display text-center focus:outline-none focus:border-volt uppercase"
      />
      <button
        type="submit"
        disabled={!text.trim() || disabled}
        className="w-full bg-volt text-background font-display text-lg py-3 skew-cta active:scale-95 transition-transform disabled:opacity-50"
      >
        LOCK IN
      </button>
    </form>
  );
}
