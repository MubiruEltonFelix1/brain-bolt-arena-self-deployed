import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";

type Theme = {
  name: string;
  bg: string;
  panel: string;
  accent: string;
  accentSoft: string;
  ring: string;
  text: string;
  subtext: string;
  divider: string;
  badgeBg: string;
  badgeText: string;
};

function themeFor(rank: number): Theme {
  if (rank === 1) {
    return { name: "Champion", bg: "#0A0A0C", panel: "linear-gradient(160deg, #1a1408 0%, #0f0b04 100%)", accent: "#F5C24C", accentSoft: "rgba(245,194,76,0.14)", ring: "rgba(245,194,76,0.45)", text: "#FBF6EA", subtext: "rgba(251,246,234,0.55)", divider: "rgba(245,194,76,0.18)", badgeBg: "rgba(245,194,76,0.14)", badgeText: "#F5C24C" };
  }
  if (rank === 2) {
    return { name: "Runner-up", bg: "#0A0A0C", panel: "linear-gradient(160deg, #16171a 0%, #0d0e10 100%)", accent: "#D6DEE6", accentSoft: "rgba(214,222,230,0.10)", ring: "rgba(214,222,230,0.35)", text: "#F4F6F8", subtext: "rgba(244,246,248,0.55)", divider: "rgba(214,222,230,0.16)", badgeBg: "rgba(214,222,230,0.10)", badgeText: "#D6DEE6" };
  }
  if (rank === 3) {
    return { name: "Third", bg: "#0A0A0C", panel: "linear-gradient(160deg, #1a120c 0%, #100b07 100%)", accent: "#CD8B5E", accentSoft: "rgba(205,139,94,0.12)", ring: "rgba(205,139,94,0.42)", text: "#F6ECE2", subtext: "rgba(246,236,226,0.55)", divider: "rgba(205,139,94,0.18)", badgeBg: "rgba(205,139,94,0.12)", badgeText: "#CD8B5E" };
  }
  return { name: "Finisher", bg: "#0A0A0C", panel: "linear-gradient(160deg, #14181a 0%, #0b0d0f 100%)", accent: "#CCFF00", accentSoft: "rgba(204,255,0,0.10)", ring: "rgba(204,255,0,0.35)", text: "#F4F4F5", subtext: "rgba(244,244,245,0.55)", divider: "rgba(255,255,255,0.08)", badgeBg: "rgba(204,255,0,0.10)", badgeText: "#CCFF00" };
}

function ordinalSuffix(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("") || "?";
}

export type ShareResultData = {
  nickname: string;
  rank: number;
  totalPlayers: number;
  score: number;
  correct: number;
  totalQuestions: number;
  longestStreak: number;
  quizTitle: string;
  leagueName?: string | null;
  achievement?: string | null;
};

const CARD_W = 1080;
const CARD_H = 1350;

/**
 * Inline responsive preview of the share card.
 * Renders the 1080x1350 card and scales it to fit its container width,
 * keeping the portrait aspect ratio.
 * The forwarded ref points to the full-resolution card element for exporting.
 */
export function ShareCardPreview({
  data,
  cardRef,
  className,
}: {
  data: ShareResultData;
  cardRef: React.MutableRefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.35);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(w / CARD_W);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: `${CARD_W} / ${CARD_H}`,
        overflow: "hidden",
        borderRadius: 28,
        boxShadow: "0 30px 80px -20px rgba(0,0,0,0.6)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: CARD_W,
          height: CARD_H,
          transformOrigin: "top left",
          transform: `scale(${scale})`,
        }}
      >
        <ShareCardVisual data={data} innerRef={cardRef} />
      </div>
    </div>
  );
}

export function ShareCardVisual({
  data,
  innerRef,
}: {
  data: ShareResultData;
  innerRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const theme = themeFor(data.rank);
  const accuracy = data.totalQuestions > 0 ? Math.round((data.correct / data.totalQuestions) * 100) : 0;

  return (
    <div
      ref={innerRef}
      style={{
        width: CARD_W,
        height: CARD_H,
        background: theme.bg,
        color: theme.text,
        fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif",
        padding: "80px 72px",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: theme.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#0A0A0C", fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em" }}>B</div>
          <div style={{ fontWeight: 700, fontSize: 22, letterSpacing: "-0.01em" }}>BrainBolt</div>
        </div>
        <div style={{ fontSize: 14, letterSpacing: "0.22em", textTransform: "uppercase", color: theme.subtext, fontWeight: 600 }}>Result Card</div>
      </div>

      <div style={{ marginTop: 72 }}>
        <div style={{ fontSize: 14, letterSpacing: "0.24em", textTransform: "uppercase", color: theme.subtext, fontWeight: 600 }}>
          {data.leagueName ? data.leagueName : "Quiz Session"}
        </div>
        <div style={{ marginTop: 12, fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, color: theme.text }}>
          {data.quizTitle}
        </div>
      </div>

      <div style={{ marginTop: 64, display: "flex", alignItems: "center", gap: 28 }}>
        <div style={{ width: 128, height: 128, borderRadius: "50%", background: theme.accentSoft, border: `2px solid ${theme.ring}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 48, fontWeight: 700, letterSpacing: "-0.02em", color: theme.accent, flexShrink: 0 }}>
          {initials(data.nickname)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, letterSpacing: "0.22em", textTransform: "uppercase", color: theme.subtext, fontWeight: 600 }}>Player</div>
          <div style={{ marginTop: 8, fontSize: 64, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 720 }}>
            {data.nickname}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 72 }}>
        <div style={{ fontSize: 16, letterSpacing: "0.24em", textTransform: "uppercase", color: theme.subtext, fontWeight: 600 }}>Final Position</div>
        <div style={{ marginTop: 12, display: "flex", alignItems: "baseline", gap: 16 }}>
          <div style={{ fontSize: 220, fontWeight: 800, letterSpacing: "-0.06em", lineHeight: 0.9, color: theme.accent }}>
            {data.rank}
            <span style={{ fontSize: 96, fontWeight: 700, marginLeft: 4 }}>{ordinalSuffix(data.rank)}</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 500, color: theme.subtext, paddingBottom: 20 }}>of {data.totalPlayers}</div>
        </div>
        {data.achievement && (
          <div style={{ marginTop: 20, display: "inline-block", padding: "10px 20px", borderRadius: 999, background: theme.badgeBg, color: theme.badgeText, fontSize: 16, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase" }}>
            {data.achievement}
          </div>
        )}
      </div>

      <div style={{ marginTop: 64, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <StatCell label="Score" value={data.score.toLocaleString()} theme={theme} emphasize />
        <StatCell label="Accuracy" value={`${accuracy}%`} theme={theme} />
        <StatCell label="Correct" value={`${data.correct}/${data.totalQuestions}`} theme={theme} />
        <StatCell label="Longest Streak" value={String(data.longestStreak)} theme={theme} />
      </div>

      <div style={{ flexGrow: 1 }} />

      <div>
        <div style={{ height: 1, background: theme.divider, margin: "0 0 28px" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 20, fontWeight: 500, color: theme.text, letterSpacing: "-0.01em" }}>Think you can beat my score?</div>
          <div style={{ fontSize: 14, letterSpacing: "0.22em", textTransform: "uppercase", color: theme.subtext, fontWeight: 600 }}>brainbolt</div>
        </div>
      </div>
    </div>
  );
}

function StatCell({ label, value, theme, emphasize }: { label: string; value: string; theme: Theme; emphasize?: boolean }) {
  return (
    <div style={{ background: theme.panel, border: `1px solid ${theme.divider}`, borderRadius: 24, padding: "28px 28px 32px" }}>
      <div style={{ fontSize: 13, letterSpacing: "0.22em", textTransform: "uppercase", color: theme.subtext, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 14, fontSize: emphasize ? 64 : 52, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: emphasize ? theme.accent : theme.text }}>{value}</div>
    </div>
  );
}

async function renderPng(node: HTMLElement, bg: string) {
  return toPng(node, { pixelRatio: 2, cacheBust: true, backgroundColor: bg });
}

export async function downloadShareCard(node: HTMLElement | null, data: ShareResultData) {
  if (!node) return;
  const theme = themeFor(data.rank);
  const dataUrl = await renderPng(node, theme.bg);
  const link = document.createElement("a");
  link.download = `brainbolt-${data.nickname.replace(/[^a-z0-9]/gi, "_")}-rank${data.rank}.png`;
  link.href = dataUrl;
  link.click();
}

export async function shareShareCard(node: HTMLElement | null, data: ShareResultData) {
  if (!node) return;
  const theme = themeFor(data.rank);
  const dataUrl = await renderPng(node, theme.bg);
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], "brainbolt-result.png", { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
    try {
      await nav.share({
        files: [file],
        title: "My BrainBolt result",
        text: `I finished ${data.rank}${ordinalSuffix(data.rank)} with ${data.score.toLocaleString()} points. Think you can beat my score?`,
      });
      return;
    } catch {
      /* user cancelled — fall through to download */
    }
  }
  const link = document.createElement("a");
  link.download = `brainbolt-${data.nickname.replace(/[^a-z0-9]/gi, "_")}-rank${data.rank}.png`;
  link.href = dataUrl;
  link.click();
}

// Kept for backward compatibility; not used by the new inline flow.
export function ShareResultCard({
  data,
  open,
  onClose,
}: {
  data: ShareResultData;
  open: boolean;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-[420px] flex flex-col items-center gap-4 my-4" onClick={(e) => e.stopPropagation()}>
        <ShareCardPreview data={data} cardRef={cardRef} />
        <div className="flex flex-col sm:flex-row gap-2 w-full">
          <button onClick={() => run(() => shareShareCard(cardRef.current, data))} disabled={busy} className="flex-1 bg-volt text-background font-display text-lg py-3 skew-cta disabled:opacity-50">
            {busy ? "PREPARING…" : "SHARE"}
          </button>
          <button onClick={() => run(() => downloadShareCard(cardRef.current, data))} disabled={busy} className="flex-1 border border-border bg-card text-foreground font-display text-lg py-3 skew-cta disabled:opacity-50">
            DOWNLOAD PNG
          </button>
          <button onClick={onClose} className="flex-1 sm:flex-none sm:px-6 border border-border bg-transparent text-foreground/70 font-mono text-xs uppercase tracking-widest py-3">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
