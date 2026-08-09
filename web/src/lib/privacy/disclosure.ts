/**
 * Tiered disclosure: what a counsellor is allowed to see, and when.
 *
 * `docs/context.md` §11 promises "counsellor sees risk card and redacted excerpts; full
 * transcript only on escalation, only with a logged reason". This module is that promise
 * as a function, so it is enforced in one place rather than re-decided at each call site.
 *
 * ## Three levels, and the thing that separates them
 *
 * | Level | Shows | Costs |
 * |---|---|---|
 * | `card` | tier, reasons, redacted quotes, timeline | nothing, logged |
 * | `transcript` | the full redacted conversation | a logged reason |
 * | `identity` | unsealed names, places, contacts | escalation + a logged reason |
 *
 * The escalating cost is the design. Every level is *reachable* — a counsellor who needs
 * a name can always get it, and a safeguarding tool that could not do that would be
 * useless in the moment it mattered. What changes is how much friction and how much
 * record. Nothing here is a lock; it is a ratchet that makes each step deliberate and
 * leaves a trace the student can read.
 *
 * ## What this is not
 *
 * Not authentication. `counsellorId` is taken on trust here, and until day 8's auth work
 * lands every action in the demo is attributed to one hardcoded actor. This module
 * decides *what a given counsellor may see*; proving they are that counsellor is a
 * separate problem and is currently unsolved.
 */

import { REASON_CHARS } from "@/lib/config";
import { ESCALATED_TIERS, Tier } from "@/lib/taxonomy";

export type DisclosureLevel = "card" | "transcript" | "identity";

export const LEVEL_ORDER: readonly DisclosureLevel[] = [
  "card",
  "transcript",
  "identity",
] as const;

export interface DisclosureRequest {
  level: DisclosureLevel;
  /** The case's post-gate tier. */
  tier: Tier;
  counsellorId: string;
  /** Required for `transcript` and `identity`. Recorded verbatim. */
  reason?: string;
  /**
   * Set when the counsellor has explicitly escalated this case. Required for `identity`.
   * Deliberately separate from tier: a T4 case is not automatically de-anonymised, a
   * human still has to decide to do it.
   */
  escalated?: boolean;
}

export interface DisclosureDecision {
  allowed: boolean;
  level: DisclosureLevel;
  /** Shown to the counsellor when refused. Says what to do, not just what failed. */
  refusal: string | null;
  /** Persist when `allowed`. The student is entitled to see this. */
  audit: {
    caseId?: string;
    counsellorId: string;
    action: "viewed_card" | "viewed_transcript" | "unsealed_pii";
    reason: string | null;
    at: string;
  } | null;
}

/**
 * Reason length required per level, from the one table in `config.ts`.
 *
 * These were literals here and again in `seal.ts`, which meant the disclosure gate and
 * the thing it guards could disagree about the same policy.
 */
const MIN_REASON: Record<DisclosureLevel, number> = {
  card: 0,
  transcript: REASON_CHARS.transcript,
  identity: REASON_CHARS.unseal,
};

const ACTION: Record<DisclosureLevel, DisclosureDecision["audit"] extends null ? never : NonNullable<DisclosureDecision["audit"]>["action"]> = {
  card: "viewed_card",
  transcript: "viewed_transcript",
  identity: "unsealed_pii",
};

export function decide(request: DisclosureRequest): DisclosureDecision {
  const { level, counsellorId } = request;
  const reason = request.reason?.trim() ?? "";

  const refuse = (refusal: string): DisclosureDecision => ({
    allowed: false,
    level,
    refusal,
    audit: null,
  });

  if (!counsellorId) {
    return refuse("No counsellor identified. Sign in to view this case.");
  }

  if (reason.length < MIN_REASON[level]) {
    return refuse(
      level === "identity"
        ? `Unsealing a student's identifying details needs a reason of at least ` +
          `${MIN_REASON.identity} characters. It is recorded and the student can see it.`
        : `Opening the full transcript needs a reason of at least ` +
          `${MIN_REASON.transcript} characters. It is recorded and the student can see it.`,
    );
  }

  if (level === "identity" && !request.escalated) {
    // A T4 tier is not consent to de-anonymise. The gate raising a tier is a machine
    // judgement; escalation is a human one, and only the second unlocks a name.
    return refuse(
      "Escalate this case first. Identifying details are only available on an escalated " +
        "case, and escalation is a decision a person makes, not one the tier makes for them.",
    );
  }

  return {
    allowed: true,
    level,
    refusal: null,
    audit: {
      counsellorId,
      action: ACTION[level],
      reason: reason || null,
      at: new Date().toISOString(),
    },
  };
}

/**
 * The highest level reachable for a case right now, for rendering the UI honestly.
 *
 * Used to decide whether to show an "unseal" control at all. A greyed-out button with an
 * explanation beats a button that fails on click — the counsellor learns the rule once,
 * at a moment when they are not urgently trying to use it.
 */
export function reachableLevel(tier: Tier, escalated: boolean): DisclosureLevel {
  if (escalated) return "identity";
  // Escalated tiers can *reach* identity, but only after someone escalates. Anything
  // below that tops out at the transcript.
  return ESCALATED_TIERS.has(tier) ? "transcript" : "transcript";
}

/** True when this case could ever expose identity, for the console's affordances. */
export function canEverUnseal(tier: Tier): boolean {
  return ESCALATED_TIERS.has(tier);
}
