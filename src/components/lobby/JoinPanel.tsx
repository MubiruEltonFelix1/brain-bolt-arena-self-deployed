import { QRCodeSVG } from "qrcode.react";
import {
  displayJoinUrl,
  formatGameCode,
  joinInstruction,
  type LobbyLayout,
} from "@/lib/lobby-layout";

/**
 * The lobby's join panel — the single most important element on a host's
 * screen. Game PIN, QR code and join URL are always visible together; the QR is
 * never behind a modal.
 *
 * Deliberately router-free and hook-free so it renders identically on the
 * server and can be unit-tested with `renderToStaticMarkup`.
 */
export function JoinPanel({
  code,
  joinUrl,
  layout,
  onCopyLink,
  onEnlarge,
  copied = false,
}: {
  code: string;
  joinUrl: string;
  layout: LobbyLayout;
  onCopyLink?: () => void;
  /** Optional: the fullscreen view is an enhancement, never the only route to the QR. */
  onEnlarge?: () => void;
  copied?: boolean;
}) {
  const grouped = formatGameCode(code);

  return (
    <section
      aria-labelledby="lobby-join-heading"
      className="relative overflow-hidden border-2 border-volt/30 bg-card"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(90% 70% at 15% 0%, color-mix(in oklab, var(--volt) 10%, transparent), transparent 65%)",
        }}
      />

      <div className="relative p-5 sm:p-8 space-y-6">
        <h2
          id="lobby-join-heading"
          className="font-display text-xl sm:text-2xl italic uppercase tracking-widest text-volt"
        >
          Game Pin
        </h2>

        <div className={layout.sideBySide ? "flex flex-wrap items-start gap-8 xl:gap-12" : "space-y-6"}>
          {/* PIN + URL take the visual lead; the QR supports them. */}
          <div className="min-w-0 flex-1 space-y-5">
            <p
              aria-label={`Game PIN ${code}`}
              className={`font-display italic leading-none tracking-[0.12em] text-foreground tabular-nums ${layout.pinClass}`}
            >
              {grouped}
            </p>

            <div className="space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
                Join at
              </p>
              {/* The visible, protocol-stripped URL is the single accessible
                  representation. A duplicate sr-only copy of the full URL would
                  make a screen reader announce the same address twice. */}
              <p className="font-mono text-sm sm:text-base text-volt break-all">
                {displayJoinUrl(joinUrl)}
              </p>
            </div>

            <p className="max-w-md text-sm text-foreground/70">{joinInstruction(code)}</p>

            <div className="flex flex-wrap gap-2 pt-1">
              {onCopyLink && (
                <button
                  type="button"
                  onClick={onCopyLink}
                  className="inline-flex min-h-11 items-center border border-volt px-4 font-mono text-xs uppercase tracking-widest text-volt transition-colors hover:bg-volt hover:text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
                >
                  {copied ? "Link copied" : "Copy join link"}
                </button>
              )}
              {onEnlarge && (
                <button
                  type="button"
                  onClick={onEnlarge}
                  className="inline-flex min-h-11 items-center border border-border px-4 font-mono text-xs uppercase tracking-widest text-foreground/70 transition-colors hover:border-volt hover:text-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
                >
                  Show QR fullscreen
                </button>
              )}
            </div>
          </div>

          {/* QR plate — white background gives the required quiet zone and keeps
              the contrast well clear of the scannable threshold. */}
          <div className="shrink-0 space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              Scan to join
            </p>
            <div className="inline-block bg-white p-4">
              <QRCodeSVG
                value={joinUrl}
                size={layout.qrSize}
                level="M"
                bgColor="#ffffff"
                fgColor="#0A0A0C"
                title={`Join game ${code} — open ${joinUrl}`}
                // The SVG carries a viewBox, so it scales down on narrow screens
                // without losing the crisp edges a QR code needs to scan.
                style={{ width: "100%", height: "auto", maxWidth: layout.qrSize }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
