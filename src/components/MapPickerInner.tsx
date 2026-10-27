import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  useMapEvents,
  Polyline,
  Polygon,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import type { GeoRegion } from "@/lib/question-registry";

// Fix default marker icons (bundlers strip Leaflet's default image resolution)
L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const guessIcon = L.divIcon({
  className: "",
  html: '<div style="background:#22D3EE;border:2px solid #0F172A;border-radius:50%;width:22px;height:22px;box-shadow:0 0 12px #22D3EE"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const correctIcon = L.divIcon({
  className: "",
  html: '<div style="background:#CCFF00;border:2px solid #0F172A;border-radius:50%;width:22px;height:22px;box-shadow:0 0 12px #CCFF00"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function ClickHandler({
  onPick,
  disabled,
}: {
  onPick?: (lat: number, lng: number) => void;
  disabled?: boolean;
}) {
  useMapEvents({
    click(e) {
      if (!disabled && onPick) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapResizer() {
  const map = useMap();

  useEffect(() => {
    const resize = () => map.invalidateSize();
    const timeout = window.setTimeout(resize, 80);
    const container = map.getContainer();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(container);

    return () => {
      window.clearTimeout(timeout);
      observer?.disconnect();
    };
  }, [map]);

  return null;
}

/**
 * Listens for Leaflet tile load errors and reports them upward. OSM tiles need
 * no API key, but they can be blocked on some networks — without this the map
 * just goes blank, which looks like a missing API key.
 */
function TileErrorMonitor({ onError }: { onError: () => void }) {
  const map = useMap();

  useEffect(() => {
    const handler = () => onError();
    map.on("tileerror", handler);
    return (): void => {
      map.off("tileerror", handler);
    };
  }, [map, onError]);

  return null;
}

export type MapPickerInnerProps = {
  height?: number;
  guess?: { lat: number; lng: number } | null;
  correct?: { lat: number; lng: number } | null;
  /** Accepted region polygon (GeoJSON [lng, lat]); rendered as a volt outline. */
  region?: GeoRegion | null;
  onPick?: (lat: number, lng: number) => void;
  disabled?: boolean;
  center?: [number, number];
  zoom?: number;
};

function RegionLayer({ region }: { region: GeoRegion }) {
  const polys =
    region.type === "Polygon"
      ? [region.coordinates as number[][][]]
      : (region.coordinates as number[][][][]);
  return (
    <>
      {polys.map((poly, i) => (
        <Polygon
          key={i}
          positions={poly[0].map(([lng, lat]) => [lat, lng] as [number, number])}
          pathOptions={{
            color: "#CCFF00",
            weight: 1.5,
            fillColor: "#CCFF00",
            fillOpacity: 0.12,
          }}
        />
      ))}
    </>
  );
}

export default function MapPickerInner({
  height = 340,
  guess,
  correct,
  region,
  onPick,
  disabled,
  center = [20, 0],
  zoom = 2,
}: MapPickerInnerProps) {
  const [tileError, setTileError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div style={{ height }} className="relative border border-border overflow-hidden">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{
          height: "100%",
          width: "100%",
          background: "#0a0a0a",
          cursor: disabled ? "default" : "crosshair",
        }}
        scrollWheelZoom
        worldCopyJump
      >
        {/* OpenStreetMap base layer keeps the picker usable without a paid tile API key. */}
        <TileLayer
          key={reloadKey}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          subdomains={["a", "b", "c"]}
        />

        <ClickHandler onPick={onPick} disabled={disabled} />
        <MapResizer />
        <TileErrorMonitor onError={() => setTileError(true)} />
        {region && <RegionLayer region={region} />}
        {guess && <Marker position={[guess.lat, guess.lng]} icon={guessIcon} />}
        {correct && <Marker position={[correct.lat, correct.lng]} icon={correctIcon} />}
        {guess && correct && (
          <Polyline
            positions={[
              [guess.lat, guess.lng],
              [correct.lat, correct.lng],
            ]}
            pathOptions={{ color: "#CCFF00", dashArray: "6 6", weight: 2 }}
          />
        )}
      </MapContainer>

      {tileError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center bg-background/95 backdrop-blur-sm border border-border">
          <p className="mb-3 text-foreground font-mono text-sm uppercase">Map tiles unavailable</p>
          <button
            onClick={() => {
              setTileError(false);
              setReloadKey((k) => k + 1);
            }}
            className="bg-volt text-background font-display text-xs uppercase py-2 px-4 skew-cta active:scale-95 transition-transform"
          >
            RETRY TILES
          </button>
        </div>
      )}
    </div>
  );
}
