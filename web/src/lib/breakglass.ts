/**
 * Break-glass: closing a case below the gate's floor.
 *
 * This is the one path in the system that overrules the deterministic safety gate, and it
 * exists because the alternative is worse. A gate tuned to miss nothing will floor cases
 * it should not — a student quoting a song lyric, a drama coursework scene, a joke that
 * pattern-matches. Without a way out, a counsellor facing a queue with four false T4s
 * learns to distrust the tier, and a tier nobody trusts protects nobody. **The escape
 * hatch is what makes the floor credible the rest of the time.**
 *
 * ## What it is not
 *
 * It is not a downgrade. `lib/overrides.ts` handles disagreement about *urgency* and
 * cannot go below the floor. Break-glass is a claim about the gate itself: "the pattern
 * fired and this case is not what it thinks it is." Different claim, different table,
 * different threshold, and countable on its own so "how often was the gate overruled last
 * term" is one query.
 *
 * It does not un-show the crisis resources. Those rendered to the student when the gate
 * fired, before any model output, and nothing here reaches back in time. A counsellor
 * deciding a case was a false positive does not make the student's having seen a helpline
 * number a mistake to be corrected.
 *
 * ## Review is after the fact, on purpose
 *
 * A two-person rule sounds stronger and is weaker. Requiring a lead's approval before the
 * button works means a counsellor at 7pm on a Friday either waits until Monday or works
 * around the system, and the second is what actually happens — the case gets closed with
 * a vague override reason instead, and the record of what was really decided is lost. So
 * the action is never blocked, every one lands unreviewed, the console shows the count,
 * and a lead clears them. The control is visibility, not permission.
 *
 * The one thing role does gate: a counsellor cannot review their own break-glass, and a
 * non-lead cannot review at all. Review is the second pair of eyes; a second pair of eyes
 * belonging to the same person is not one.
 */

import { recordAccess } from "@/lib/audit";
import type { Principal } from "@/lib/auth/session";
import { REASON_CHARS } from "@/lib/config";
import type { BreakGlassRecord, Store } from "@/lib/store";
import { READ_FIRST_REFUSAL, hasReadTranscript } from "@/lib/transcript";
import { Tier, tierRank } from "@/lib/taxonomy";

/**
 * Four times the override threshold.
 *
 * Not friction for its own sake: a lead reading this row weeks later, with no memory of
 * the case, has to be able to tell whether the call was reasonable. "false positive" does
 * not carry that. "student was quoting lyrics from a song, confirmed in the transcript,
 * no self-harm content anywhere else in the conversation" does.
 */
export const MIN_BREAK_GLASS_REASON_CHARS = REASON_CHARS.breakGlass;

export const MIN_REVIEW_NOTE_CHARS = REASON_CHARS.breakGlassReview;

export class BreakGlassError extends Error {}

export interface BreakGlassInput {
  caseId: string;
  principal: Principal;
  /** The gate's floor. Required, and `null` is refused: there is nothing to break. */
  gateFloor: Tier | null;
  /** The tier the counsellor is closing at. Must be below the floor. */
  closedAtTier: Tier;
  reason: string;
  at?: Date;
}

export async function breakGlass(
  store: Store,
  input: BreakGlassInput,
): Promise<BreakGlassRecord> {
  if (input.gateFloor === null) {
    // Not a technicality. If there is no floor, `recordOverride` already does what the
    // counsellor wants, at a tenth of the ceremony, and routing an ordinary disagreement
    // through here would fill the lead's review list with cases that never needed one.
    throw new BreakGlassError(
      "The safety gate did not floor this case, so there is nothing to break. Use the " +
        "override control instead.",
    );
  }

  if (tierRank(input.closedAtTier) >= tierRank(input.gateFloor)) {
    throw new BreakGlassError(
      `Closing at ${input.closedAtTier} is at or above the gate's floor of ` +
        `${input.gateFloor}, so an ordinary override covers it. Break-glass is only for ` +
        "going below the floor.",
    );
  }

  const reason = input.reason.trim();
  if (reason.length < MIN_BREAK_GLASS_REASON_CHARS) {
    throw new BreakGlassError(
      `Breaking glass requires a reason of at least ${MIN_BREAK_GLASS_REASON_CHARS} ` +
        "characters. A safeguarding lead will read it, possibly weeks from now, with no " +
        "memory of this case. Say what made you certain.",
    );
  }

  // The strongest claim in the product — "the gate is wrong about this case" — made from
  // the artifact least able to support it. Of the two controls this guard covers, this is
  // the one it exists for: the reason threshold is 40 characters precisely so a lead can
  // judge the call later, and "student was quoting song lyrics, confirmed in the
  // transcript" is not a sentence anyone can write without having opened one.
  if (!(await hasReadTranscript(store, input.caseId, input.principal.counsellorId))) {
    throw new BreakGlassError(READ_FIRST_REFUSAL);
  }

  const at = input.at ?? new Date();

  const record = await store.appendBreakGlass({
    caseId: input.caseId,
    counsellorId: input.principal.counsellorId,
    counsellorEmail: input.principal.email,
    gateFloor: input.gateFloor,
    closedAtTier: input.closedAtTier,
    reason,
    at: at.toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
  });

  await recordAccess(store, {
    caseId: input.caseId,
    principal: input.principal,
    action: "broke_glass",
    reason,
    at,
  });

  return record;
}

export interface ReviewInput {
  id: string;
  principal: Principal;
  note: string;
  at?: Date;
}

export async function reviewBreakGlass(
  store: Store,
  input: ReviewInput,
): Promise<BreakGlassRecord> {
  if (input.principal.role !== "lead") {
    throw new BreakGlassError(
      "Only a designated safeguarding lead can review a break-glass closure.",
    );
  }

  const note = input.note.trim();
  if (note.length < MIN_REVIEW_NOTE_CHARS) {
    throw new BreakGlassError(
      `A review needs a note of at least ${MIN_REVIEW_NOTE_CHARS} characters. "Agreed" ` +
        "with nothing after it is not a review.",
    );
  }

  const found = await store.breakGlassById(input.id);
  if (!found) throw new BreakGlassError("No such break-glass record.");

  if (found.counsellorId === input.principal.counsellorId) {
    throw new BreakGlassError(
      "You cannot review your own break-glass. Ask another safeguarding lead.",
    );
  }

  if (found.reviewedAt !== null) {
    throw new BreakGlassError(
      `This was already reviewed on ${found.reviewedAt}. A review is written once, so it ` +
        "stays the account given at the time.",
    );
  }

  const at = input.at ?? new Date();
  const reviewed = await store.reviewBreakGlass({
    id: input.id,
    reviewedBy: input.principal.counsellorId,
    reviewedAt: at.toISOString(),
    reviewNote: note,
  });
  if (!reviewed) throw new BreakGlassError("No such break-glass record.");

  await recordAccess(store, {
    caseId: reviewed.caseId,
    principal: input.principal,
    action: "reviewed_break_glass",
    reason: note,
    at,
  });

  return reviewed;
}

export function unreviewed(store: Store): Promise<BreakGlassRecord[]> {
  return store.unreviewedBreakGlass();
}

export function breakGlassForCase(store: Store, caseId: string): Promise<BreakGlassRecord[]> {
  return store.breakGlassForCase(caseId);
}

/** True when this case has an unreviewed break-glass closure against it. */
export async function isOpenBreakGlass(store: Store, caseId: string): Promise<boolean> {
  const rows = await store.breakGlassForCase(caseId);
  return rows.some((r) => r.reviewedAt === null);
}
