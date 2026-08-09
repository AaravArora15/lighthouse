/**
 * Retention: deleting what we said we would delete, when we said we would.
 *
 * The student is told, up front and in the consent copy, that a conversation which does
 * not lead anywhere is deleted after `RETENTION_DAYS_NON_ESCALATED` days. That sentence is
 * the only reason some students type anything at all, so it is a promise with a date on
 * it, and a promise with a date is either kept by a job that runs or it is a lie with
 * better wording.
 *
 * ## Deletion here means content, not existence
 *
 * The turns and the encrypted PII map are erased. The conversation row survives as a
 * tombstone holding the case id, the tier, and the date of deletion, and the access log is
 * untouched. Two different promises are involved and only the first was made: *what you
 * wrote will be gone* is the commitment; *there will be no trace anything happened* is not,
 * and it cannot be, because a counsellor who read a case must stay accountable for having
 * read it after the case is gone. The audit tables key on `case_id` with no foreign key
 * specifically so this job has no mechanism to erase them.
 *
 * ## Three reasons a conversation survives its date
 *
 * 1. **It is escalated** (T3 or T4). A safeguarding record is not ours to delete on a
 *    timer, and the student is told this too.
 * 2. **An explicit hold**, with a written reason. Nullable text and not a boolean, so an
 *    extension has to be justified rather than ticked.
 * 3. **An unreviewed break-glass**. A lead has to be able to read the case a colleague
 *    closed against the gate's judgement. Deleting it before that review would erase the
 *    evidence for the one check that makes break-glass safe — and this is the interaction
 *    that is easy to miss, because each half looks correct alone.
 *
 * Every exemption is reported by name in the sweep's result. A retention job that silently
 * skips records is indistinguishable from one that is broken.
 */

import * as config from "@/lib/config";
import type { RetentionRecord, Store } from "@/lib/store";
import { ESCALATED_TIERS, Tier } from "@/lib/taxonomy";

export const DAY_MS = 86_400_000;

export type ExemptionReason =
  | "escalated"
  | "explicit_hold"
  | "unreviewed_break_glass"
  | "already_deleted";

export interface RetentionDecision {
  caseId: string;
  /** `null` when nothing is due yet and no exemption applies. */
  exemption: ExemptionReason | null;
  dueAt: string | null;
  delete: boolean;
}

export interface SweepResult {
  ranAt: string;
  scanned: number;
  deleted: string[];
  exempt: { caseId: string; reason: ExemptionReason }[];
  notYetDue: number;
}

/**
 * The date a conversation becomes deletable, or `null` if it never does.
 *
 * Computed from the tier rather than stored, so a case escalated later in its life stops
 * having an expiry rather than keeping the one it was written with.
 */
export function retentionExpiry(startedAt: string | Date, tier: Tier | null): string | null {
  if (tier !== null && ESCALATED_TIERS.has(tier)) return null;
  const start = typeof startedAt === "string" ? new Date(startedAt) : startedAt;
  return new Date(
    start.getTime() + config.RETENTION_DAYS_NON_ESCALATED * DAY_MS,
  ).toISOString();
}

/**
 * Decide one record. Pure, so the policy can be exhaustively tested without a store.
 *
 * `hasUnreviewedBreakGlass` is passed in rather than looked up, which keeps this function
 * total and makes the caller's one database read explicit.
 */
export function decide(
  record: RetentionRecord,
  now: Date,
  hasUnreviewedBreakGlass: boolean,
): RetentionDecision {
  const dueAt = record.retentionExpiresAt ?? retentionExpiry(record.startedAt, record.tier);

  const exempt = (reason: ExemptionReason): RetentionDecision => ({
    caseId: record.caseId,
    exemption: reason,
    dueAt,
    delete: false,
  });

  if (record.contentDeletedAt) return exempt("already_deleted");

  // Checked before the date, and in this order. An escalated case has no expiry at all, so
  // testing the date first would depend on `dueAt` being null and turn a policy statement
  // into an accident of arithmetic.
  if (record.tier !== null && ESCALATED_TIERS.has(record.tier)) return exempt("escalated");
  if (record.retentionHoldReason) return exempt("explicit_hold");
  if (hasUnreviewedBreakGlass) return exempt("unreviewed_break_glass");

  if (dueAt === null) return exempt("escalated");

  return {
    caseId: record.caseId,
    exemption: null,
    dueAt,
    delete: new Date(dueAt).getTime() <= now.getTime(),
  };
}

export interface SweepOptions {
  now?: Date;
  /**
   * Report what would be deleted without deleting it.
   *
   * The default, and the route's default too. A job that erases children's disclosures
   * should have to be asked twice, and the first answer should be a list a human can read.
   */
  dryRun?: boolean;
}

export async function sweep(store: Store, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? true;

  const records = await store.retentionCandidates();
  const result: SweepResult = {
    ranAt: now.toISOString(),
    scanned: records.length,
    deleted: [],
    exempt: [],
    notYetDue: 0,
  };

  for (const record of records) {
    const openGlass = (await store.breakGlassForCase(record.caseId)).some(
      (b) => b.reviewedAt === null,
    );
    const decision = decide(record, now, openGlass);

    if (decision.exemption) {
      // `already_deleted` is bookkeeping, not an exemption a human needs to see.
      if (decision.exemption !== "already_deleted") {
        result.exempt.push({ caseId: record.caseId, reason: decision.exemption });
      }
      continue;
    }
    if (!decision.delete) {
      result.notYetDue += 1;
      continue;
    }
    if (!dryRun) {
      await store.deleteConversationContent(record.caseId, now.toISOString());
    }
    result.deleted.push(record.caseId);
  }

  return result;
}

/** One line per exemption, for the job's log output. */
export function describeSweep(result: SweepResult): string {
  const verb = result.deleted.length === 1 ? "conversation" : "conversations";
  const lines = [
    `scanned ${result.scanned}, deleted ${result.deleted.length} ${verb}, ` +
      `${result.notYetDue} not yet due, ${result.exempt.length} exempt`,
  ];
  for (const e of result.exempt) lines.push(`  exempt ${e.caseId}: ${e.reason}`);
  return lines.join("\n");
}
