import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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

function ClickHandler({ onPick, disabled }: { onPick?: (lat: number, lng: number) => void; disabled?: boolean }) {
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

export type MapPickerInnerProps = {
  height?: number;
  guess?: { lat: number; lng: number } | null;
  correct?: { lat: number; lng: number } | null;
  onPick?: (lat: number, lng: number) => void;
  disabled?: boolean;
  center?: [number, number];
  zoom?: number;
};

export default function MapPickerInner({
  height = 340,
  guess,
  correct,
  onPick,
  disabled,
  center = [20, 0],
  zoom = 2,
}: MapPickerInnerProps) {
  return (
    <div style={{ height }} className="border border-border overflow-hidden">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: "100%", width: "100%", background: "#0a0a0a", cursor: disabled ? "default" : "crosshair" }}
        scrollWheelZoom
        worldCopyJump
      >
        {/* Clean political base: country borders + coastlines, no labels */}
        <TileLayer
          attribution='&copy; OpenStreetMap &copy; CARTO'
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png"
          subdomains={["a", "b", "c", "d"]}
        />


        <ClickHandler onPick={onPick} disabled={disabled} />
        <MapResizer />
        {guess && <Marker position={[guess.lat, guess.lng]} icon={guessIcon} />}
        {correct && <Marker position={[correct.lat, correct.lng]} icon={correctIcon} />}
        {guess && correct && (
          <Polyline
            positions={[[guess.lat, guess.lng], [correct.lat, correct.lng]]}
            pathOptions={{ color: "#CCFF00", dashArray: "6 6", weight: 2 }}
          />
        )}
      </MapContainer>
    </div>
  );
}
