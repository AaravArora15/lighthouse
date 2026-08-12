/**
 * Tier overrides: the counsellor's correction, kept rather than applied.
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
 * get missed. A counsellor who genuinely needs to close such a case does so through
 * `lib/breakglass.ts`, which is logged differently and is deliberately harder.
 *
 * Day 6 shipped a bug here worth remembering: the floor was inferred from
 * `card.tierFloorReason`, which is null whenever the model already agreed with the gate.
 * On exactly the cases where the floor mattered most there appeared to be no floor, and a
 * T4 self-harm case could be downgraded to T1. The floor is now passed explicitly and
 * `gateFloor` is a required field rather than an optional one, so omitting it does not
 * compile.
 */

import { recordAccess } from "@/lib/audit";
import type { Principal } from "@/lib/auth/session";
import { REASON_CHARS } from "@/lib/config";
import type { OverrideRecord, Store } from "@/lib/store";
import { READ_FIRST_REFUSAL, hasReadTranscript } from "@/lib/transcript";
import { Tier, applyFloor, tierRank } from "@/lib/taxonomy";

export const MIN_OVERRIDE_REASON_CHARS = REASON_CHARS.override;

export class OverrideError extends Error {}

export interface OverrideInput {
  caseId: string;
  principal: Principal;
  predictedTier: Tier;
  requestedTier: Tier;
  reason: string;
  /** The gate's floor for this conversation. `null` when the gate did not fire. */
  gateFloor: Tier | null;
  at?: Date;
}

export async function recordOverride(
  store: Store,
  input: OverrideInput,
): Promise<OverrideRecord> {
  const reason = input.reason.trim();
  if (reason.length < MIN_OVERRIDE_REASON_CHARS) {
    throw new OverrideError(
      `An override needs a reason of at least ${MIN_OVERRIDE_REASON_CHARS} characters.`,
    );
  }

  // Checked in the writer, not at the call site. Same argument as the mandatory-reason
  // rule in `audit.ts`: a check at each call site is the check that is missing from the
  // seventh one. See `lib/transcript.ts` for why reading comes first.
  if (!(await hasReadTranscript(store, input.caseId, input.principal.counsellorId))) {
    throw new OverrideError(READ_FIRST_REFUSAL);
  }

  const effectiveTier = applyFloor(input.requestedTier, input.gateFloor);
  const at = input.at ?? new Date();

  const flooredNotice =
    effectiveTier !== input.requestedTier
      ? `Recorded as ${effectiveTier}, not ${input.requestedTier}: the safety gate floors ` +
        `this conversation at ${input.gateFloor}. Your reason has been logged against it. ` +
        `To close it below the floor you have to break glass, which a lead will review.`
      : null;

  const record = await store.putOverride({
    caseId: input.caseId,
    counsellorId: input.principal.counsellorId,
    counsellorEmail: input.principal.email,
    predictedTier: input.predictedTier,
    requestedTier: input.requestedTier,
    effectiveTier,
    flooredNotice,
    reason,
    at: at.toISOString(),
  });

  await recordAccess(store, {
    caseId: input.caseId,
    principal: input.principal,
    action: "overrode_tier",
    reason,
    at,
  });

  return record;
}

export function overrideFor(store: Store, caseId: string): Promise<OverrideRecord | null> {
  return store.overrideForCase(caseId);
}

export function allOverrides(store: Store): Promise<OverrideRecord[]> {
  return store.allOverrides();
}

/** The tier a counsellor should act on: their override if there is one, else the model's. */
export function effectiveTier(override: OverrideRecord | null, cardTier: Tier): Tier {
  return override?.effectiveTier ?? cardTier;
}

/** True when an override moved a case, for the "edited" marker in the queue. */
export function wasMoved(override: OverrideRecord | null, cardTier: Tier): boolean {
  return Boolean(override && tierRank(override.effectiveTier) !== tierRank(cardTier));
}
