export type NumberFormat = "general" | "year" | "decimal" | "percentage" | "currency";

export function getNumberFormat(options: unknown): NumberFormat {
  const f = Array.isArray(options) ? (options[0] as string) : undefined;
  if (f === "year" || f === "decimal" || f === "percentage" || f === "currency") return f;
  return "general";
}

export function formatNumber(v: number | null | undefined, format: NumberFormat): string {
  if (v == null || !isFinite(v as number)) return "—";
  const n = Number(v);
  switch (format) {
    case "year":
      return String(Math.trunc(n));
    case "percentage":
      return `${n}%`;
    case "currency":
      return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
    case "decimal":
      return String(n);
    case "general":
    default:
      return Math.trunc(n).toLocaleString();
  }
}
