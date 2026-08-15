import { Slider } from "@/components/ui/slider";
import { formatNumber, type NumberFormat } from "@/lib/number-format";

export function NumberGuess({
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
  correct,
  unit,
  format = "general",
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  correct?: number | null;
  unit?: string;
  format?: NumberFormat;
}) {
  const fmt = (n: number) => formatNumber(n, format);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 50;
  const correctPct = correct != null && max > min ? ((correct - min) / (max - min)) * 100 : null;
  const diff = correct != null ? Math.abs(value - correct) : null;

  return (
    <div className="space-y-6 select-none">
      <div className="text-center space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/40">Your guess</p>
        <p className="font-display text-6xl italic text-volt leading-none">
          {fmt(value)}
          {unit && <span className="text-2xl text-foreground/60 ml-2">{unit}</span>}
        </p>
        {diff != null && (
          <p className="font-mono text-xs text-foreground/60">
            Off by <span className={diff === 0 ? "text-volt" : "text-pink-shock"}>{fmt(diff)}</span>
          </p>
        )}
      </div>

      <div className="relative pt-6 pb-3">
        {/* Correct answer marker */}
        {correctPct != null && (
          <div
            className="absolute top-0 -translate-x-1/2 flex flex-col items-center"
            style={{ left: `${Math.max(0, Math.min(100, correctPct))}%` }}
          >
            <span className="font-mono text-[9px] uppercase text-volt whitespace-nowrap">✓ {fmt(correct!)}</span>
            <span className="w-px h-4 bg-volt" />
          </div>
        )}
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(v) => onChange(v[0])}
          disabled={disabled}
          className="w-full"
        />
        {/* Range labels */}
        <div className="flex justify-between font-mono text-[10px] uppercase text-foreground/40 mt-3">
          <span>{fmt(min)}{unit ? ` ${unit}` : ""}</span>
          <span className="text-foreground/60">Drag to guess</span>
          <span>{fmt(max)}{unit ? ` ${unit}` : ""}</span>
        </div>
        {/* Fill hint */}
        <div className="absolute left-0 right-0 top-[calc(1.5rem+2px)] h-1 pointer-events-none">
          <div className="absolute inset-y-0 bg-volt/30" style={{ left: 0, width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
