/**
 * Tier overrides and the counsellor access log.
 *
 * **In-memory, and that is a stated limitation rather than a design.** There is no
 * `DATABASE_URL` yet, so these live in a module-level Map and vanish on restart. The
 * Drizzle tables they belong in already exist (`db/schema.ts`: `tier_overrides`,
 * `counsellor_access`) with the same fields, so switching to Neon is a driver change.
 * Until then the console is honest about it in the UI rather than implying persistence.
 *
 * ## Why an override is recorded rather than applied
 *
 * A counsellor disagreeing with the model is the most valuable signal this system can
 * produce — it is the only ground truth that comes from someone who actually knows the
 * student. Overwriting the prediction would destroy it. So the model's tier stays on the
 * card, the override sits beside it, and both are visible.
 *
 * The reason field is mandatory. An override without one is an opinion; with one it is
 * training data, and day 4's note that the corpus is only 80 rows makes every real label
 * worth capturing properly.
 *
 * ## What an override cannot do
 *
 * It cannot lower a gate floor. `applyFloor` runs over the override exactly as it runs
 * over the model's prediction, so a counsellor who marks a T4 self-harm disclosure as T1
 * gets T4 with their reason recorded against it. That invariant has no exception for
 * humans: the gate exists precisely because the moment of judgement is the moment things
 * get missed. A counsellor who genuinely needs to close a case does so through the
 * break-glass path on day 8, which is logged differently and deliberately harder.
 */

import { Tier, applyFloor, tierRank } from "@/lib/taxonomy";

export interface TierOverride {
  caseId: string;
  counsellorId: string;
  predictedTier: Tier;
  /** What the counsellor asked for. May differ from `effectiveTier`. */
  requestedTier: Tier;
  /** What they got, after the gate floor was re-applied. */
  effectiveTier: Tier;
  /** Set when the floor prevented the requested change. Shown in the UI. */
  flooredNotice: string | null;
  reason: string;
  at: string;
}

export interface AccessEntry {
  caseId: string;
  counsellorId: string;
  action: "viewed_card" | "viewed_transcript" | "overrode_tier";
  reason: string | null;
  at: string;
}

const overrides = new Map<string, TierOverride>();
const accessLog: AccessEntry[] = [];

export function recordAccess(entry: Omit<AccessEntry, "at">): void {
  accessLog.push({ ...entry, at: new Date().toISOString() });
}

export function accessFor(caseId: string): AccessEntry[] {
  return accessLog.filter((e) => e.caseId === caseId);
}

export function overrideFor(caseId: string): TierOverride | undefined {
  return overrides.get(caseId);
}

export function allOverrides(): TierOverride[] {
  return [...overrides.values()];
}

export interface OverrideInput {
  caseId: string;
  counsellorId: string;
  predictedTier: Tier;
  requestedTier: Tier;
  reason: string;
  /** The gate's floor for this conversation. `null` when the gate did not fire. */
  gateFloor: Tier | null;
}

export function recordOverride(input: OverrideInput): TierOverride {
  const effectiveTier = applyFloor(input.requestedTier, input.gateFloor);

  const flooredNotice =
    effectiveTier !== input.requestedTier
      ? `Recorded as ${effectiveTier}, not ${input.requestedTier}: the safety gate floors ` +
        `this conversation at ${input.gateFloor}. Your reason has been logged against it.`
      : null;

  const entry: TierOverride = {
    caseId: input.caseId,
    counsellorId: input.counsellorId,
    predictedTier: input.predictedTier,
    requestedTier: input.requestedTier,
    effectiveTier,
    flooredNotice,
    reason: input.reason,
    at: new Date().toISOString(),
  };

  overrides.set(input.caseId, entry);
  recordAccess({
    caseId: input.caseId,
    counsellorId: input.counsellorId,
    action: "overrode_tier",
    reason: input.reason,
  });
  return entry;
}

/** The tier a counsellor should act on: their override if there is one, else the model's. */
export function effectiveTier(caseId: string, cardTier: Tier): Tier {
  return overrides.get(caseId)?.effectiveTier ?? cardTier;
}

/** True when an override moved a case, for the "edited" marker in the queue. */
export function wasMoved(caseId: string, cardTier: Tier): boolean {
  const o = overrides.get(caseId);
  return Boolean(o && tierRank(o.effectiveTier) !== tierRank(cardTier));
}
