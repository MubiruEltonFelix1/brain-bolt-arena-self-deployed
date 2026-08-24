// Central question-type registry.
//
// One place that knows what a question type is called, how it looks in the
// intro screen, what shape its answer takes and the small pure helpers every
// surface (host, player, Arena, Training) needs to grade or render it.
//
// Adding a question type means adding an entry here plus its body in
// `src/components/question/QuestionBodies.tsx` — not editing three routes.

export const INTRO_DURATION_MS = 5000;

export type QuestionTypeId =
  | "mcq"
  | "image_mcq"
  | "true_false"
  | "number"
  | "image_reveal"
  | "audio"
  | "ordering"
  | "type"
  | "feedback"
  | "map_pin";

/** How the player's answer is expressed. Drives which body component renders. */
export type AnswerKind = "choice" | "order" | "geo" | "number" | "text";

export type QuestionTypeDef = {
  icon: string;
  name: string;
  description: string;
  accent: "volt" | "pink-shock" | "cyan-jolt" | "amber-spark";
  /** Shape of the submitted answer. */
  answerKind: AnswerKind;
  /** False only for opinion collection (no correct answer, no points). */
  scored: boolean;
  /** Extra media the body renders alongside the prompt. */
  media: "image" | "image_reveal" | "audio" | "map" | null;
};

const REGISTRY: Record<string, QuestionTypeDef> = {
  mcq: {
    icon: "🧠",
    name: "Quick Pick",
    description: "Choose the correct answer",
    accent: "volt",
    answerKind: "choice",
    scored: true,
    media: null,
  },
  image_mcq: {
    icon: "🧠",
    name: "Quick Pick",
    description: "Choose the correct answer",
    accent: "volt",
    answerKind: "choice",
    scored: true,
    media: "image",
  },
  true_false: {
    icon: "⚖️",
    name: "Fact or Fiction",
    description: "Decide what is true",
    accent: "pink-shock",
    answerKind: "choice",
    scored: true,
    media: null,
  },
  number: {
    icon: "🎯",
    name: "Closest Shot",
    description: "Get as close as possible",
    accent: "amber-spark",
    answerKind: "number",
    scored: true,
    media: null,
  },
  image_reveal: {
    icon: "👀",
    name: "Mystery Reveal",
    description: "Identify before the image appears",
    accent: "cyan-jolt",
    answerKind: "choice",
    scored: true,
    media: "image_reveal",
  },
  audio: {
    icon: "🎧",
    name: "Sound Detective",
    description: "Listen carefully",
    accent: "cyan-jolt",
    answerKind: "choice",
    scored: true,
    media: "audio",
  },
  ordering: {
    icon: "🧩",
    name: "Sequence Master",
    description: "Arrange everything correctly",
    accent: "pink-shock",
    answerKind: "order",
    scored: true,
    media: null,
  },
  type: {
    icon: "✍️",
    name: "Thought Bubble",
    description: "Share your answer",
    accent: "volt",
    answerKind: "text",
    scored: true,
    media: null,
  },
  feedback: {
    icon: "💬",
    name: "Voice of the Crowd",
    description: "Tell us what you think",
    accent: "cyan-jolt",
    answerKind: "text",
    scored: false,
    media: null,
  },
  map_pin: {
    icon: "🗺️",
    name: "Pin Drop",
    description: "Find it on the map",
    accent: "cyan-jolt",
    answerKind: "geo",
    scored: true,
    media: "map",
  },
};

export function getQuestionType(type: string): QuestionTypeDef {
  return REGISTRY[type] ?? REGISTRY.mcq;
}

export function getAnswerKind(type: string): AnswerKind {
  return getQuestionType(type).answerKind;
}

/* ------------------------------------------------------------------ */
/* Pure helpers shared by every surface                                */
/* ------------------------------------------------------------------ */

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Blur schedule for image-reveal questions on the solo surfaces
 * (Arena + Training). 24px → 0 across `stages` steps.
 */
export function soloRevealBlur(elapsedMs: number, totalMs: number, stages?: number | null) {
  const s = Math.max(2, stages ?? 5);
  const stage = Math.min(s, Math.floor((elapsedMs / Math.max(totalMs, 1)) * s));
  return { stage, stages: s, blurPx: Math.max(0, 24 - (24 / s) * stage) };
}

/**
 * Blur schedule used on the live player screen. Intentionally distinct from
 * `soloRevealBlur`: the live screen also shows "stage x of y" to the room and
 * starts from a heavier 32px blur.
 */
export function liveRevealBlur(elapsedMs: number, totalMs: number, stages?: number | null) {
  const s = Math.max(2, Math.min(10, stages ?? 5));
  const stage = Math.min(s - 1, Math.floor((elapsedMs / Math.max(totalMs, 1)) * s));
  const fraction = stage / (s - 1);
  return { stage, stages: s, blurPx: Math.max(0, Math.round((1 - fraction) * 32)) };
}

/** Partial credit for ordering: share of items in the right slot. */
export function orderingRatio(submitted: string[], correct: string[]) {
  if (!correct.length) return 0;
  const hits = submitted.reduce((acc, label, i) => acc + (label === correct[i] ? 1 : 0), 0);
  return hits / correct.length;
}

/* ------------------------------------------------------------------ */
/* Geo regions (map_pin grading)                                       */
/* ------------------------------------------------------------------ */

/**
 * A GeoJSON geometry for an accepted map-pin region. Coordinate order is
 * GeoJSON's **[lng, lat]** — the SQL helpers in
 * `supabase/migrations/20260820090000_phase_8e_geo_region_grading.sql`
 * (`geo_point_in_region`, `geo_region_border_km`) read the same convention and
 * MUST stay behaviorally identical to the TS helpers below.
 */
export type GeoRegion = {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][][] | number[][][];
};

/** Even-odd ray casting over one ring ([lng, lat] vertices). */
function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  let j = ring.length - 1;
  for (let k = 0; k < ring.length; k++) {
    const [lng2, lat2] = ring[k];
    const [jlng, jlat] = ring[j];
    if ((lng2 > lng) !== (jlng > lng) && lat < ((jlat - lat2) * (lng - lng2)) / (jlng - lng2) + lat2) {
      inside = !inside;
    }
    j = k;
  }
  return inside;
}

/** True when the point lies inside the region (exterior ring; holes flip to outside). */
export function pointInRegion(lat: number, lng: number, region: GeoRegion): boolean {
  const polys = region.type === "Polygon" ? [region.coordinates as number[][][]] : (region.coordinates as number[][][][]);
  for (const poly of polys) {
    if (poly.length === 0) continue;
    if (!pointInRing(lat, lng, poly[0])) continue;
    let inHole = false;
    for (let c = 1; c < poly.length; c++) {
      if (pointInRing(lat, lng, poly[c])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Distance from the point to the nearest region border segment. Projects each
 * ring edge into an equirectangular plane around the click latitude, clamps
 * the click onto the segment, converts back and takes the haversine — a
 * faithful point-to-segment distance at these latitudes/scales. Mirrors the
 * SQL `geo_region_border_km` exactly.
 */
export function regionBorderKm(lat: number, lng: number, region: GeoRegion): number {
  const polys = region.type === "Polygon" ? [region.coordinates as number[][][]] : (region.coordinates as number[][][][]);
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const px = lng * cosLat;
  const py = lat;
  let min = Infinity;
  for (const poly of polys) {
    for (const ring of poly) {
      if (ring.length < 2) continue;
      let ax = ring[0][0] * cosLat;
      let ay = ring[0][1];
      for (let k = 1; k < ring.length; k++) {
        const bx = ring[k][0] * cosLat;
        const by = ring[k][1];
        const dx = bx - ax;
        const dy = by - ay;
        let t = 0;
        const denom = dx * dx + dy * dy;
        if (denom > 0) {
          t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom));
        }
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        const d = haversineKm({ lat, lng }, { lat: cy, lng: cx / cosLat });
        if (d < min) min = d;
        ax = bx;
        ay = by;
      }
    }
  }
  return min;
}

/**
 * Unified map-pin correctness (0..1) shared by every surface. Region mode:
 * inside → 1, outside → falloff by distance to the border. Point mode: linear
 * falloff from the pin. `correct` everywhere = correctness ≥ 0.9. This is the
 * single formula the SQL graders (`submit_geo_answer`,
 * `evaluate_question_answer`) implement too.
 */
export function geoCorrectness(
  point: { lat: number; lng: number },
  spec: { lat: number | null; lng: number | null; maxDistanceKm: number | null; region?: GeoRegion | null },
): number {
  const tol = Math.max(spec.maxDistanceKm ?? 5000, 1);
  if (spec.region) {
    if (pointInRegion(point.lat, point.lng, spec.region)) return 1;
    const borderKm = regionBorderKm(point.lat, point.lng, spec.region);
    return Math.max(0, 1 - (Number.isFinite(borderKm) ? borderKm : 0) / tol);
  }
  const dist = haversineKm(point, { lat: spec.lat ?? 0, lng: spec.lng ?? 0 });
  return Math.max(0, 1 - dist / tol);
}

/** Partial credit for a map pin, relative to the tolerance radius (unified formula). */
export function geoRatio(distanceKm: number, toleranceKm: number) {
  return Math.max(0, 1 - distanceKm / Math.max(1, toleranceKm));
}

/** Partial credit for a numeric guess, relative to the allowed range. */
export function numberRatio(diff: number, min: number, max: number) {
  const range = Math.max(1, max - min);
  return Math.max(0, 1 - diff / (range / 2));
}
