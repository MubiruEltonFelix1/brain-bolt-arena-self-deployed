// src/components/Confetti.tsx — celebratory falling pieces.
// Shared by the host "GG WP" screen and the player final standings.
// `loop` = keep falling forever (host full-screen celebration); set to false
// for a single pass over a contained area.
// The inline <style> also defines podium-rise / badge-pop, which the host
// PodiumCard relies on — keep all three keyframes here.

const CONFETTI_COLORS = ["#CCFF00", "#FF2D55", "#7CE7FF", "#FFC857", "#F4F4F5"];

export function Confetti({ loop = true, className }: { loop?: boolean; className?: string }) {
  const pieces = Array.from({ length: 60 });
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`}>
      {pieces.map((_, i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 3;
        const duration = 3 + Math.random() * 3;
        const size = 6 + Math.random() * 8;
        const rotate = Math.random() * 360;
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        return (
          <span
            key={i}
            className="absolute top-[-20px] block opacity-80"
            style={{
              left: `${left}%`,
              width: `${size}px`,
              height: `${size * 0.4}px`,
              background: color,
              transform: `rotate(${rotate}deg)`,
              animation: `confetti-fall ${duration}s linear ${delay}s ${loop ? "infinite" : "1"}`,
            }}
          />
        );
      })}
      <style>{`@keyframes confetti-fall { 0% { transform: translateY(-20px) rotate(0deg); opacity: 0; } 10% { opacity: 1; } 100% { transform: translateY(720px) rotate(720deg); opacity: 0.9; } } @keyframes podium-rise { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } } @keyframes badge-pop { 0% { transform: scale(0.5); opacity: 0; } 60% { transform: scale(1.15); } 100% { transform: scale(1); opacity: 1; } }`}</style>
    </div>
  );
}
