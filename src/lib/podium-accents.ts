// Podium accent classes.
//
// WHY THIS IS A STATIC MAP AND NOT A TEMPLATE STRING
// The results and round-reveal screens used to build class names by
// interpolation, e.g. `` `text-${accent}` `` and `` `border-${accent}/40` ``.
// Tailwind's scanner reads class names as literal strings in source files; an
// interpolated name is invisible to it, so `text-volt` and `text-cyan-jolt`
// only ever rendered because they happened to be force-listed in styles.css's
// `@source inline(...)`. Everything NOT on that list silently produced no CSS
// at all - which is why second and third place had no coloured border.
//
// Every class used by the podium now appears verbatim in this file, so the
// scanner finds it and the utility is always generated. Keep them literal.
//
// Adding a place means adding an entry here; never reintroduce a template.

export const PODIUM_ACCENT_TEXT: Record<number, string> = {
  1: "text-volt",
  2: "text-cyan-jolt",
  3: "text-amber-spark",
};

export const PODIUM_ACCENT_BORDER: Record<number, string> = {
  1: "border-volt",
  2: "border-cyan-jolt",
  3: "border-amber-spark",
};

export const PODIUM_ACCENT_BORDER_SOFT: Record<number, string> = {
  1: "border-volt/30",
  2: "border-cyan-jolt/30",
  3: "border-amber-spark/30",
};

export const PODIUM_ACCENT_SURFACE: Record<number, string> = {
  1: "bg-volt/5",
  2: "bg-cyan-jolt/5",
  3: "bg-amber-spark/5",
};

/** Anyone outside the top three gets the neutral foreground colour. */
export const NO_ACCENT_TEXT = "text-foreground";

export function accentText(rank: number): string {
  return PODIUM_ACCENT_TEXT[rank] ?? NO_ACCENT_TEXT;
}

export function accentBorder(rank: number): string {
  return PODIUM_ACCENT_BORDER[rank] ?? "border-border";
}
