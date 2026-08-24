// scripts/build-country-regions.mjs
//
// Generates src/lib/geo/country-regions.ts (full curated dataset) and
// src/lib/geo/kenya-demo.ts (single-entry module for the training demo) from
// Natural Earth 110m admin-0 countries (public domain).
//
// Source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
//
// Pipeline per country:
//   1. Drop any ring whose longitude span > 180° (antimeridian guard — this
//      excludes Russia, Fiji and Alaska's Aleutians while keeping the US
//      mainland). A feature left with no rings is skipped with a warning.
//   2. Simplify with a built-in Douglas-Peucker at ~0.05° (~5 km).
//   3. Round coordinates to 3 decimals (~110 m).
//   4. Label point from Natural Earth label_x/label_y, falling back to the
//      vertex-average centroid.
//
// Usage: bun scripts/build-country-regions.mjs
// Output files are deterministic (stable sort, fixed rounding) and committed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

// Curated non-African extras (all of Africa is included via CONTINENT).
const EXTRAS = [
  "USA", "CAN", "MEX", "BRA", "ARG", "IND", "CHN", "JPN", "AUS", "GBR",
  "FRA", "DEU", "ITA", "ESP", "PRT", "NLD", "SWE", "NOR", "TUR", "SAU",
  "ARE", "PAK", "IDN", "THA", "VNM", "PHL", "KOR", "NZL",
];

const SIMPLIFY_TOL_DEG = 0.05;

// Common names that differ from the Natural Earth ADMIN label — the app
// importer and MCP CSV round-trip resolve regions by name, so these aliases
// keep "Tanzania", "United States", "Ivory Coast" etc. importable.
const ALIASES = {
  TZA: ["tanzania"],
  USA: ["united states", "usa", "america"],
  GBR: ["uk", "great britain", "britain"],
  ARE: ["uae", "emirates"],
  KOR: ["south korea"],
  COD: ["dr congo", "drc", "democratic republic of congo"],
  COG: ["congo"],
  CIV: ["ivory coast"],
  CPV: ["cape verde"],
  CZE: ["czech republic"],
  IRN: ["iran"],
  VNM: ["vietnam"],
  PSE: ["palestine", "west bank"],
  SWZ: ["eswatini", "swaziland"],
  TWN: ["taiwan"],
  BOL: ["bolivia"],
  VEN: ["venezuela"],
  MMR: ["myanmar", "burma"],
  LAO: ["laos"],
  TLS: ["east timor"],
};

function perpDistDeg(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function douglasPeucker(points, tol) {
  if (points.length < 3) return points;
  let maxDist = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistDeg(points[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > tol) {
    const left = douglasPeucker(points.slice(0, idx + 1), tol);
    const right = douglasPeucker(points.slice(idx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function simplifyRing(ring) {
  // GeoJSON rings are closed (first == last). Simplify the open chain, re-close.
  const open = ring.slice(0, -1);
  if (open.length < 3) return null;
  const simplified = douglasPeucker(open, SIMPLIFY_TOL_DEG);
  if (simplified.length < 3) return null;
  const closed = [...simplified, simplified[0]].map(([lng, lat]) => [round3(lng), round3(lat)]);
  // Dedupe consecutive identical points after rounding (doubles ring size otherwise).
  const out = [];
  for (const pt of closed) {
    const last = out[out.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
    out.pop();
  }
  return out.length >= 3 ? [...out, out[0]] : null;
}

function lngSpan(ring) {
  let min = Infinity;
  let max = -Infinity;
  for (const [lng] of ring) {
    if (lng < min) min = lng;
    if (lng > max) max = lng;
  }
  return max - min;
}

function centroidOf(rings) {
  let sumLat = 0;
  let sumLng = 0;
  let count = 0;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      sumLat += lat;
      sumLng += lng;
      count++;
    }
  }
  return { lat: round3(sumLat / Math.max(count, 1)), lng: round3(sumLng / Math.max(count, 1)) };
}

const resp = await fetch(SOURCE_URL);
if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
const geojson = await resp.json();

const skipped = [];
const entries = [];

for (const feature of geojson.features ?? []) {
  const p = feature.properties ?? {};
  const iso = String(p.ISO_A3 ?? "").toUpperCase();
  const name = String(p.ADMIN || p.NAME || iso);
  const isAfrica = p.CONTINENT === "Africa";
  if (!isAfrica && !EXTRAS.includes(iso)) continue;
  if (!iso || iso === "-99" || iso === "ATA") {
    skipped.push(`${name}: no ISO_A3 / Antarctica`);
    continue;
  }

  const geom = feature.geometry;
  const rawPolys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  const polys = [];
  for (const rawPoly of rawPolys) {
    const rings = [];
    for (const rawRing of rawPoly) {
      if (lngSpan(rawRing) > 180) continue; // antimeridian guard
      const ring = simplifyRing(rawRing);
      if (ring) rings.push(ring);
    }
    if (rings.length) polys.push(rings);
  }
  if (!polys.length) {
    skipped.push(`${name}: no rings survived (antimeridian/too small)`);
    continue;
  }

  const label =
    Number.isFinite(Number(p.label_x)) && Number.isFinite(Number(p.label_y))
      ? { lat: round3(Number(p.label_y)), lng: round3(Number(p.label_x)) }
      : centroidOf(polys.flat());

  entries.push({
    key: iso.toLowerCase(),
    name,
    label,
    region: {
      type: polys.length === 1 ? "Polygon" : "MultiPolygon",
      coordinates: polys.length === 1 ? polys[0] : polys,
    },
    ...(ALIASES[iso] ? { aliases: ALIASES[iso] } : {}),
  });
}

entries.sort((a, b) => a.name.localeCompare(b.name));

const vertexCount = entries.reduce(
  (sum, e) => sum + e.region.coordinates.flat(2).length,
  0,
);

const fmt = (entries) =>
  entries.map((e) => {
    const coordJson = JSON.stringify(e.region.coordinates);
    const aliases = (e.aliases ?? []).length
      ? `, aliases: ${JSON.stringify(e.aliases)}`
      : "";
    return `  { key: ${JSON.stringify(e.key)}, name: ${JSON.stringify(e.name)}, label: { lat: ${e.label.lat}, lng: ${e.label.lng} }, region: { type: "${e.region.type}", coordinates: ${coordJson} }${aliases} },`;
  }).join("\n");

const header = `// AUTO-GENERATED by scripts/build-country-regions.mjs — do not edit by hand.
// Natural Earth 110m admin-0 countries (public domain), simplified ~0.05°.
// Used ONLY by the quiz editor + MCP to author map_pin region questions.
import type { GeoRegion } from "@/lib/question-registry";`;

const full = `${header}

export type CountryRegion = {
  key: string;
  name: string;
  label: { lat: number; lng: number };
  region: GeoRegion;
  aliases?: string[];
};

export const COUNTRY_REGIONS: CountryRegion[] = [
${fmt(entries)}
];

const LOOKUP = new Map(COUNTRY_REGIONS.map((c) => [c.key, c]));

export function findCountryRegion(query: string): CountryRegion | null {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return null;
  return (
    LOOKUP.get(q) ??
    COUNTRY_REGIONS.find(
      (c) =>
        c.name.toLowerCase() === q || (c.aliases ?? []).some((a) => a.toLowerCase() === q),
    ) ??
    null
  );
}
`;

const kenya = entries.find((e) => e.key === "ken");
if (!kenya) throw new Error("Kenya not found in generated dataset!");

const kenyaModule = `${header}

// Single-entry module (Kenya) so the Training demo can import the region
// without pulling the whole dataset into the client bundle.
export const KENYA_REGION: GeoRegion = {
  type: "${kenya.region.type}",
  coordinates: ${JSON.stringify(kenya.region.coordinates)},
};

export const KENYA_LABEL = { lat: ${kenya.label.lat}, lng: ${kenya.label.lng} };
`;

const GEO_DIR = join(ROOT, "src", "lib", "geo");
mkdirSync(GEO_DIR, { recursive: true });
writeFileSync(join(GEO_DIR, "country-regions.ts"), full);
writeFileSync(join(GEO_DIR, "kenya-demo.ts"), kenyaModule);

console.log(
  `Generated ${entries.length} countries (${vertexCount} vertices total) → src/lib/geo/country-regions.ts + kenya-demo.ts`,
);
console.log(`Skipped: ${skipped.length ? skipped.join(", ") : "none"}`);
