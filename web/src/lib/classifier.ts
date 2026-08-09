/**
 * The client for the scoring service.
 *
 * One job: ask Python for a better card, and **never let that request hurt the student**.
 * Every failure mode returns `null`, the caller keeps the gate-only card it already
 * stored, and the console keeps saying "gate only". There is no error path that reaches a
 * browser and no exception that escapes this module.
 *
 * ## Why every failure is expected rather than exceptional
 *
 * The service is a free Hugging Face Space that sleeps after 48 hours and cold-starts in
 * about 30 seconds. The *first request of the day timing out is the normal case*, not a
 * fault. Writing this as "try the classifier, fall back on error" would be describing a
 * rare event; it is not rare, and the code says so.
 *
 * `docs/context.md` §9 named this as the two-runtime risk on day 1 and specified the
 * mitigation: seeded demo data ships precomputed, and the live path degrades to gate-only
 * triage with a timeout. This is that mitigation.
 *
 * ## What it must never do
 *
 * It must never be able to *lower* a tier below the gate's floor. It does not need a check
 * for that here: the service runs `apply_verdict` itself, and the gate floor is
 * recalculated on the Python side from the same turns. Both runtimes independently arrive
 * at the same floor, which is precisely what the cross-runtime conformance suite asserts.
 */

import type { EscalationCard } from "@/lib/cards";
import * as config from "@/lib/config";

export interface ScoreInput {
  caseId: string;
  handle: string;
  startedAt: string;
  turns: { role: "student" | "assistant"; text: string }[];
}

/** Why a card came back gate-only. Logged, and useful when a demo misbehaves. */
export type ClassifierOutcome =
  | "scored"
  | "not_configured"
  | "timeout"
  | "unavailable"
  | "bad_response";

export interface ScoreResult {
  card: EscalationCard | null;
  outcome: ClassifierOutcome;
  /** Milliseconds spent waiting. Recorded even on failure, for the deploy runbook. */
  ms: number;
}

export function classifierUrl(): string | null {
  const raw = process.env.LIGHTHOUSE_CLASSIFIER_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : null;
}

export function hasClassifier(): boolean {
  return classifierUrl() !== null;
}

export async function scoreConversation(input: ScoreInput): Promise<ScoreResult> {
  const base = classifierUrl();
  const started = Date.now();

  // Unset is a normal deployment, not a misconfiguration: the whole demo works without it.
  if (!base) return { card: null, outcome: "not_configured", ms: 0 };

  // AbortController rather than Promise.race, because race leaves the request running.
  // On a sleeping Space that means a queue of abandoned cold starts piling up behind a
  // student who has already been answered.
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    config.CLASSIFIER_TIMEOUT_SECONDS * 1000,
  );

  try {
    const response = await fetch(`${base}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: abort.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      console.warn(`[classifier] ${response.status} from ${base}/score`);
      return { card: null, outcome: "unavailable", ms: Date.now() - started };
    }

    const card = (await response.json()) as EscalationCard;

    // Shape check before trusting it. A card missing a tier would render a blank badge on
    // a counsellor's queue, which is worse than the honest gate-only card we already have.
    if (!card || typeof card.tier !== "string" || !Array.isArray(card.reasons)) {
      console.warn("[classifier] response was not a card");
      return { card: null, outcome: "bad_response", ms: Date.now() - started };
    }

    return {
      // Trust the service's own fields, but pin the identity to what we asked about: a
      // card that came back describing a different case must not be written to this one.
      card: { ...card, caseId: input.caseId, handle: input.handle, awaitingClassifier: false },
      outcome: "scored",
      ms: Date.now() - started,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    if (!timedOut) console.warn("[classifier] unreachable:", error);
    return {
      card: null,
      outcome: timedOut ? "timeout" : "unavailable",
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
