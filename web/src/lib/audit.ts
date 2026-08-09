/**
 * The counsellor access log.
 *
 * `docs/context.md` §11 promises the student can see who opened their case. That promise
 * is only worth making if the record is (a) written on every access without the caller
 * having to remember, (b) impossible to edit or delete afterwards, and (c) legible to a
 * fifteen-year-old rather than to a DBA. This module is (a) and (c); the store interface
 * is (b), by not offering a delete.
 *
 * ## Two invariants enforced here rather than at call sites
 *
 * **A reason is mandatory on the actions that need one.** `unsealed_pii` and
 * `broke_glass` throw without a substantive one. Enforced in the writer because a check
 * at each call site is a check that is missing from the seventh call site.
 *
 * **The actor's email is copied into the row.** Denormalised on purpose — see the schema
 * header. An audit row has to stay readable after the account it names is deleted.
 */

import type { Principal } from "@/lib/auth/session";
import { REASON_CHARS } from "@/lib/config";
import type { AccessRecord, AuditAction, Store } from "@/lib/store";

/** Actions that cannot be written without a reason, and the length each demands. */
export const REASON_REQUIRED: Partial<Record<AuditAction, number>> = {
  viewed_transcript: REASON_CHARS.transcript,
  unsealed_pii: REASON_CHARS.unseal,
  overrode_tier: REASON_CHARS.override,
  broke_glass: REASON_CHARS.breakGlass,
  reviewed_break_glass: REASON_CHARS.breakGlassReview,
};

export class AuditError extends Error {}

export interface AccessInput {
  caseId: string;
  principal: Principal;
  action: AuditAction;
  reason?: string | null;
  at?: Date;
}

export async function recordAccess(store: Store, input: AccessInput): Promise<AccessRecord> {
  const reason = input.reason?.trim() || null;
  const required = REASON_REQUIRED[input.action];

  if (required !== undefined && (reason === null || reason.length < required)) {
    throw new AuditError(
      `"${input.action}" requires a reason of at least ${required} characters. It is ` +
        "recorded against your name and the student can read it.",
    );
  }

  return store.appendAccess({
    caseId: input.caseId,
    counsellorId: input.principal.counsellorId,
    counsellorEmail: input.principal.email,
    action: input.action,
    reason,
    at: (input.at ?? new Date()).toISOString(),
  });
}

export function accessForCase(store: Store, caseId: string): Promise<AccessRecord[]> {
  return store.accessForCase(caseId);
}

/** Plain-language description of one row, for the receipt a student reads. */
export function describeAccess(entry: AccessRecord): string {
  switch (entry.action) {
    case "viewed_card":
      return "Opened the summary of your conversation.";
    case "viewed_transcript":
      return "Read the full conversation.";
    case "unsealed_pii":
      return "Looked up names or places you mentioned.";
    case "overrode_tier":
      return "Changed how urgent your case is marked.";
    case "broke_glass":
      return "Closed your case despite the safety check flagging it.";
    case "reviewed_break_glass":
      return "Reviewed another counsellor's decision to close your case.";
  }
}
