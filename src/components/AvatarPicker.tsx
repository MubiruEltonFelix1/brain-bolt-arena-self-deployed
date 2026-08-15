import { AVATARS } from "@/assets/avatars";

type Props = {
  value: string | null | undefined;
  onChange: (id: string) => void;
  columns?: number;
};

export function AvatarPicker({ value, onChange, columns = 5 }: Props) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label="Choose your Brain Bolt avatar"
    >
      {AVATARS.map((a) => {
        const selected = value === a.id;
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={a.name}
            onClick={() => onChange(a.id)}
            className={
              "relative aspect-square rounded-full overflow-hidden border-2 transition-all bg-background " +
              (selected
                ? "border-volt scale-105 shadow-[0_0_18px_rgba(204,255,0,0.35)]"
                : "border-border hover:border-foreground/40 opacity-80 hover:opacity-100")
            }
          >
            <img src={a.url} alt={a.name} className="w-full h-full object-cover" loading="lazy" />
          </button>
        );
      })}
    </div>
  );
}
