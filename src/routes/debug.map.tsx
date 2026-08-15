import { createFileRoute } from "@tanstack/react-router";
import { MapPicker } from "@/components/MapPicker";
import { NumberGuess } from "@/components/NumberGuess";
import { useState } from "react";

export const Route = createFileRoute("/debug/map")({ component: Debug });

function Debug() {
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [n, setN] = useState(50);
  return (
    <div className="p-6 space-y-6 max-w-md mx-auto">
      <h1 className="text-xl">Map</h1>
      <MapPicker height={340} guess={pin} onPick={(lat, lng) => setPin({ lat, lng })} />
      <h1 className="text-xl">Number</h1>
      <div className="bg-card border border-border p-5">
        <NumberGuess min={0} max={100} value={n} onChange={setN} />
      </div>
    </div>
  );
}
