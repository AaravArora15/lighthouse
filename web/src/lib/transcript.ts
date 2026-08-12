/**
 * The full redacted transcript, and the rule that makes it a precondition rather than a
 * feature.
 *
 * ## Why this exists at all
 *
 * `docs/context.md` §11 promised three levels of disclosure and only the first shipped.
 * `privacy/disclosure.ts` had the policy written and tested with no caller, `seal.ts` had
 * `unseal()` with no caller, and the counsellor's card printed *"The full transcript is
 * available only on escalation, with a logged reason"* over a path that did not exist.
 * Third time this project has rendered a promise nothing implemented.
 *
 * ## Why reading it is required before disagreeing
 *
 * This is the part that is a design decision rather than a bug fix, and it is recorded in
 * `docs/context.md` §17.
 *
 * The card is assembled to *support* its tier. `model/card.py` picks quotes with
 * `argsort(risk)` descending and sorts gate hits the same way; the reasons come from a
 * closed bank fired by what the gate matched. Every item on it is there because it agrees
 * with the tier, and nothing in the pipeline selects for evidence that contradicts one.
 *
 * That is correct for triage — "should I look at this?" — and wrong for adjudication —
 * "is this right?". The console asks both questions from the same artifact.
 *
 * The consequence is concrete. The corpus deliberately contains `"i stopped cutting last
 * year"`; two of the last three gate bugs were a missing contraction, so assume a variant
 * slips a suppressor. The card then shows T4, a first-person cutting reason, and the
 * cutting clause as its quote. The words that make it a false positive — "last year", "my
 * friend", "in a book" — sit in low-scoring turns, which is precisely why the card filters
 * them out. Break-glass then asks "what makes you certain the gate is wrong here?" while
 * showing only material saying it is right.
 *
 * There is a second cost. `overrides.ts` calls its reason "the only ground truth that comes
 * from someone who actually knows the student", and §8 has overrides feeding thresholds. A
 * label formed from three quotes selected to agree with the tier is not ground truth, and
 * feeding it back is worse than collecting nothing because it looks like signal.
 *
 * So: **a counsellor may read a case without deciding anything, but may not decide without
 * reading.** The transcript costs a logged sentence, not permission. Nothing is blocked;
 * the order is fixed.
 */

import { recordAccess } from "@/lib/audit";
import type { Principal } from "@/lib/auth/session";
import { decide } from "@/lib/privacy/disclosure";
import type { AccessRecord, Store } from "@/lib/store";
import type { Tier } from "@/lib/taxonomy";

export class TranscriptError extends Error {}

/** One turn as a counsellor reads it. Redacted; there is no raw copy to return. */
export interface TranscriptTurn {
  ordinal: number;
  role: string;
  text: string;
}

export interface OpenTranscriptInput {
  caseId: string;
  principal: Principal;
  /** The case's post-gate tier, for `disclosure.decide`. */
  tier: Tier;
  reason: string;
  at?: Date;
}

/**
 * Authorise, log, then return. In that order.
 *
 * The write lands before the turns are handed back, so a caller that throws while
 * rendering still leaves the record of the access that was already granted. The same
 * ordering as `recordAccess` on the card page, for the same reason.
 *
 * An empty result is still logged. A case whose turns were erased by the retention job
 * has been *opened* by this counsellor either way, and an audit log that quietly omits the
 * accesses that turned up nothing is not an audit log.
 */
export async function openTranscript(
  store: Store,
  input: OpenTranscriptInput,
): Promise<TranscriptTurn[]> {
  const decision = decide({
    level: "transcript",
    tier: input.tier,
    counsellorId: input.principal.counsellorId,
    reason: input.reason,
  });

  if (!decision.allowed) {
    throw new TranscriptError(decision.refusal ?? "Refused.");
  }

  await recordAccess(store, {
    caseId: input.caseId,
    principal: input.principal,
    action: "viewed_transcript",
    reason: input.reason.trim(),
    at: input.at,
  });

  return store.turnsForCase(input.caseId);
}

/**
 * Has this counsellor opened this case's transcript?
 *
 * Pure, over rows the caller already has. The card page fetches the access log to render
 * it, so deriving the answer costs nothing extra there.
 *
 * **Per counsellor, deliberately.** A colleague having read the case does not qualify
 * anyone else to overrule the gate on it. The claim being made by an override is "I have
 * seen this conversation and I disagree", and that is first-person or it is nothing.
 */
export function transcriptWasRead(
  accesses: readonly AccessRecord[],
  counsellorId: string,
): boolean {
  return accesses.some(
    (a) => a.action === "viewed_transcript" && a.counsellorId === counsellorId,
  );
}

/** The same question against the store, for writers that do not already hold the rows. */
export async function hasReadTranscript(
  store: Store,
  caseId: string,
  counsellorId: string,
): Promise<boolean> {
  return transcriptWasRead(await store.accessForCase(caseId), counsellorId);
}

/**
 * The refusal a control shows when it is reached before the transcript.
 *
 * Shared so the override panel, the break-glass panel and both route handlers say the
 * same sentence. A rule explained three different ways reads as three different rules.
 */
export const READ_FIRST_REFUSAL =
  "Open the full conversation before changing this. The card shows the evidence that " +
  "produced the tier, never the evidence against it, so it cannot tell you whether the " +
  "tier is wrong. Reading costs a logged sentence.";
