import { lazy, Suspense, useEffect, useState } from "react";
import type { MapPickerInnerProps } from "./MapPickerInner";

const MapPickerInner = lazy(() => import("./MapPickerInner"));

export function MapPicker(props: MapPickerInnerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const h = props.height ?? 340;
  if (!mounted) {
    return (
      <div style={{ height: h }} className="border border-border bg-card grid place-items-center font-mono text-xs text-foreground/40">
        MAP LOADING…
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div style={{ height: h }} className="border border-border bg-card grid place-items-center font-mono text-xs text-foreground/40">
          MAP LOADING…
        </div>
      }
    >
      <MapPickerInner {...props} />
    </Suspense>
  );
}
