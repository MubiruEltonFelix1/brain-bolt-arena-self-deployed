import { resolveAvatar } from "@/lib/avatar";

type Props = {
  avatarId?: string | null;
  /** Used to pick a deterministic fallback avatar when avatarId is missing. */
  seed?: string | null;
  size?: number;
  className?: string;
  alt?: string;
};

export function PlayerAvatar({ avatarId, seed, size = 32, className, alt = "" }: Props) {
  const a = resolveAvatar(avatarId, seed);
  return (
    <img
      src={a.url}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      className={
        "inline-block rounded-full object-cover bg-background border border-border shrink-0 " +
        (className ?? "")
      }
      style={{ width: size, height: size }}
    />
  );
}
