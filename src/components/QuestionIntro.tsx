import { getQuestionMeta } from "@/lib/question-meta";

type Props = {
  questionType: string;
  progress: number;
  roundNumber?: number;
  totalRounds?: number;
  variant?: "host" | "player";
  questionText?: string;
  doublePoints?: boolean;
  playersReady?: number;
  playersTotal?: number;
};

const ACCENT_VAR: Record<string, string> = {
  volt: "var(--volt)",
  "pink-shock": "var(--pink-shock)",
  "cyan-jolt": "var(--cyan-jolt)",
  "amber-spark": "var(--amber-spark)",
};

export function QuestionIntro({
  questionType,
  progress,
  roundNumber,
  totalRounds,
  variant = "player",
  questionText,
  doublePoints,
  playersReady,
  playersTotal,
}: Props) {
  const meta = getQuestionMeta(questionType);
  const clampedProgress = Math.max(0, Math.min(1, progress));

  const color = ACCENT_VAR[meta.accent] ?? "var(--volt)";
  const tint = `color-mix(in oklab, ${color} 12%, transparent)`;
  const bgTint = `color-mix(in oklab, ${color} 18%, transparent)`;
  const glow = `0 0 60px color-mix(in oklab, ${color} 40%, transparent)`;

  return (
    <div
      className="relative overflow-hidden bg-card border-2 p-8 sm:p-12 min-h-[420px] flex flex-col items-center justify-center text-center animate-fade-in"
      style={{ borderColor: color, backgroundColor: tint, boxShadow: glow }}
    >
      {roundNumber && totalRounds && (
        <p className="absolute top-4 left-4 font-mono text-[10px] uppercase text-foreground/60">
          Question {roundNumber} of {totalRounds}
        </p>
      )}

      {doublePoints && (
        <p
          className="absolute top-4 right-4 font-mono text-[10px] uppercase px-2 py-1 border animate-pulse"
          style={{ color, borderColor: color, backgroundColor: bgTint }}
        >
          ⭐ Double Points
        </p>
      )}

      <div
        key={questionType}
        className="text-7xl sm:text-8xl mb-6 rounded-full size-28 sm:size-36 grid place-items-center animate-scale-in"
        style={{ backgroundColor: bgTint, animation: "scale-in 300ms ease-out, pulse 2s ease-in-out infinite 300ms" }}
      >
        <span>{meta.icon}</span>
      </div>

      <h2
        className="font-display text-4xl sm:text-6xl uppercase italic tracking-tight animate-fade-in"
        style={{ color }}
      >
        {meta.name}
      </h2>
      <p className="mt-2 font-mono text-xs sm:text-sm uppercase text-foreground/70">
        {meta.description}
      </p>

      {variant === "host" && questionText && (
        <p className="mt-6 max-w-2xl font-display text-2xl sm:text-3xl italic text-foreground animate-fade-in">
          {questionText}
        </p>
      )}

      {variant === "host" && typeof playersTotal === "number" && playersTotal > 0 && (
        <p className="mt-6 font-mono text-xs uppercase text-foreground/60">
          Players Ready:{" "}
          <span className="text-foreground">
            {playersReady ?? 0} / {playersTotal}
          </span>
        </p>
      )}

      {variant === "player" && (
        <p
          className="mt-8 font-display text-3xl sm:text-4xl uppercase italic animate-pulse"
          style={{ color }}
        >
          Get Ready...
        </p>
      )}

      <div className="absolute bottom-0 left-0 h-1 bg-border w-full">
        <div
          className="h-full"
          style={{ width: `${clampedProgress * 100}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
