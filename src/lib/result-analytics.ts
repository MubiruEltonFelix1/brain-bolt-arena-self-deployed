// Lightweight, privacy-conscious measurement of the result journey.
//
// THERE IS NO ANALYTICS VENDOR IN THIS PROJECT
// `package.json` ships no analytics SDK and `src/` contains no tracking client.
// Rather than pretend a funnel exists, this module is the single place where
// result-journey events are named and shaped, with a sink that is empty by
// default. Nothing leaves the browser until a sink is installed deliberately.
//
// WHAT IT WILL NEVER SEND
// Events are a closed union, and properties are a closed allowlist per event.
// Anything not on the list is dropped at the call boundary, so a future edit
// that tries to attach a claim token, an auth error, a session id or a rival's
// nickname cannot smuggle it through by widening a payload object.
//
// Specifically never recorded: claim tokens, participant secrets, email
// addresses, display names, raw scores, question or answer content, session or
// participant ids, and any raw error message. Modes are coarse buckets
// ("hosted" / "arena") and outcomes are coarse buckets ("succeeded" /
// "failed"), which is what a funnel actually needs.
//
// This is deliberately not an analytics platform. There is no identity, no
// cross-session stitching and no aggregation here.

export type ResultJourneyEvent =
  | "result_viewed"
  | "save_result_clicked"
  | "sign_in_started_from_result"
  | "sign_up_started_from_result"
  | "authentication_completed_from_result"
  | "result_claim_started"
  | "result_claim_succeeded"
  | "result_claim_failed"
  | "result_share_clicked"
  | "result_share_completed"
  | "replay_clicked";

export type ResultMode = "hosted" | "arena";
export type ClaimOutcome = "succeeded" | "failed";

/**
 * The complete set of properties any event may carry. Deliberately coarse: a
 * mode, an outcome, and booleans. No identifiers of any kind.
 */
export type ResultEventProps = {
  mode: ResultMode;
  outcome?: ClaimOutcome;
  /** True when the result was already on an account before this interaction. */
  alreadySaved?: boolean;
  /** Which share path was used. "native" is only observable where supported. */
  shareMethod?: "native" | "copy" | "image";
};

const EVENTS: ReadonlySet<string> = new Set<ResultJourneyEvent>([
  "result_viewed",
  "save_result_clicked",
  "sign_in_started_from_result",
  "sign_up_started_from_result",
  "authentication_completed_from_result",
  "result_claim_started",
  "result_claim_succeeded",
  "result_claim_failed",
  "result_share_clicked",
  "result_share_completed",
  "replay_clicked",
]);

export type ResultEvent = {
  event: ResultJourneyEvent;
  props: ResultEventProps;
};

type Sink = (e: ResultEvent) => void;

let sink: Sink | null = null;

/**
 * Install a transport. Nothing calls this today. It exists so that adding one
 * is a single, auditable line rather than a refactor of every call site - and
 * so the shape of what would be sent is defined by the code below rather than
 * by whatever an SDK happens to accept.
 */
export function setResultAnalyticsSink(next: Sink | null): void {
  sink = next;
}

/** In-memory tail, for debugging and for asserting in tests. */
const buffer: ResultEvent[] = [];
const BUFFER_LIMIT = 100;

export function resultEventBuffer(): readonly ResultEvent[] {
  return buffer;
}

export function clearResultEventBuffer(): void {
  buffer.length = 0;
}

export function trackResultEvent(event: ResultJourneyEvent, props: ResultEventProps): void {
  // Unknown event names are dropped rather than forwarded, so a typo cannot
  // silently create a stream of unattributable rows in a future sink.
  if (!EVENTS.has(event)) return;

  const clean: ResultEventProps = { mode: props.mode };
  if (props.outcome !== undefined) clean.outcome = props.outcome;
  if (props.alreadySaved !== undefined) clean.alreadySaved = props.alreadySaved;
  if (props.shareMethod !== undefined) clean.shareMethod = props.shareMethod;

  const payload: ResultEvent = { event, props: clean };
  buffer.push(payload);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();

  // A throwing sink must never break the results screen.
  try {
    sink?.(payload);
  } catch {
    /* measurement is never allowed to fail a player's result view */
  }
}

/**
 * Native share is only observable where the Web Share API exists; the fallback
 * is always observable. Reported as a share_method so a funnel can tell the
 * difference without pretending the native path worked everywhere.
 */
export function detectShareMethod(): "native" | "copy" | "image" {
  if (typeof navigator === "undefined") return "copy";
  if (typeof navigator.share === "function" && typeof navigator.canShare === "function") return "native";
  return "copy";
}
