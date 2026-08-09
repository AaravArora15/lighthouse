/**
 * The storage contract, as plain TypeScript.
 *
 * Everything that outlives a request goes through this interface, and there are exactly
 * two implementations: `memory.ts` and `postgres.ts`. The split exists for one reason
 * stated in the root CLAUDE.md — **behaviour tests must run offline: no API key, no
 * database, no network** — and the way to honour that without stubbing the code under test
 * is to make the real code take a store and hand it a real in-memory one.
 *
 * ## Why an interface at all, rather than just using Drizzle everywhere
 *
 * A module-level `Map` was the day 6 shortcut and it has a specific failure mode on
 * Vercel: each serverless instance gets its own module scope, so an override written by a
 * POST is invisible to the next page render if it lands on a different instance. That is
 * not a stale-cache annoyance, it is a counsellor's correction silently disappearing. The
 * in-memory store is therefore for tests and local runs only, and the app in deployment
 * always has `DATABASE_URL` set.
 *
 * ## Append-only means append-only
 *
 * There is no `deleteAccess`, no `updateAccess`, and no `deleteBreakGlass` on this
 * interface. Not as an oversight: the retention job's whole job is deletion and it still
 * cannot reach these, because the operation does not exist to call. `reviewBreakGlass` is
 * the single mutation permitted on an audit row, it only ever fills in fields that were
 * null, and it is itself recorded.
 */

import type { EscalationCard } from "@/lib/cards";
import type { Tier } from "@/lib/taxonomy";

export type CounsellorRole = "counsellor" | "lead";

export interface CounsellorRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: CounsellorRole;
  active: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface SessionRecord {
  id: string;
  counsellorId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * Every action is scoped to a case, because `counsellor_access` answers exactly one
 * question: who looked at this student's material, and why. Sign-in and sign-out are
 * deliberately absent — they belong to no case, and `counsellor_sessions` already records
 * when each one started and ended.
 */
export type AuditAction =
  | "viewed_card"
  | "viewed_transcript"
  | "unsealed_pii"
  | "overrode_tier"
  | "broke_glass"
  | "reviewed_break_glass";

export interface AccessRecord {
  id: string;
  /** Monotonic insertion order. Breaks ties when two rows share a millisecond. */
  seq: number;
  caseId: string;
  counsellorId: string;
  counsellorEmail: string;
  action: AuditAction;
  reason: string | null;
  at: string;
}

export interface OverrideRecord {
  id: string;
  caseId: string;
  counsellorId: string;
  counsellorEmail: string;
  predictedTier: Tier;
  requestedTier: Tier;
  effectiveTier: Tier;
  /** Set when the floor prevented the requested change. Rendered to the counsellor. */
  flooredNotice: string | null;
  reason: string;
  at: string;
}

export interface BreakGlassRecord {
  id: string;
  caseId: string;
  counsellorId: string;
  counsellorEmail: string;
  gateFloor: Tier;
  closedAtTier: Tier;
  reason: string;
  at: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

/**
 * The retention job's view of a conversation. Deliberately narrow: the job decides whether
 * a record may be deleted and must never be in a position to read what it is deleting.
 */
export interface RetentionRecord {
  caseId: string;
  tier: Tier | null;
  startedAt: string;
  retentionExpiresAt: string | null;
  retentionHoldReason: string | null;
  contentDeletedAt: string | null;
}

/**
 * One stored turn. `text` is REDACTED; `spans` are the identifying pieces that were taken
 * out, already sealed. The two travel together so a caller cannot write one without the
 * other — storing redacted text and forgetting the PII map would lose the information
 * silently, and storing raw text is the thing the schema exists to prevent.
 */
export interface LiveTurn {
  ordinal: number;
  role: "student" | "assistant";
  /** Redacted. Never a raw student turn. */
  text: string;
  spans: { entityType: string; placeholder: string; ciphertext: string }[];
}

export interface LiveConversationInput {
  caseId: string;
  handle: string;
  startedAt: string;
  tier: Tier | null;
  confidence: number | null;
  tierFloorReason: string | null;
  gateLevel: "clear" | "grey" | "high" | null;
  gateIndicators: string[];
  crisisResourcesShown: boolean;
  retentionExpiresAt: string | null;
  card: EscalationCard;
  turns: LiveTurn[];
}

export interface Store {
  readonly kind: "memory" | "postgres";

  // -- counsellors --------------------------------------------------------------------
  counsellorByEmail(email: string): Promise<CounsellorRecord | null>;
  counsellorById(id: string): Promise<CounsellorRecord | null>;
  createCounsellor(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role?: CounsellorRole;
  }): Promise<CounsellorRecord>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  touchCounsellor(id: string, at: string): Promise<void>;
  listCounsellors(): Promise<CounsellorRecord[]>;
  /** Soft disable. The row and its audit history stay; only sign-in stops working. */
  setCounsellorActive(id: string, active: boolean): Promise<void>;

  // -- sessions -----------------------------------------------------------------------
  createSession(input: {
    counsellorId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<SessionRecord>;
  sessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(tokenHash: string, at: string): Promise<void>;
  /** Used when an account is disabled. Every live session for that person ends at once. */
  revokeSessionsFor(counsellorId: string, at: string): Promise<void>;

  // -- audit (append-only) ------------------------------------------------------------
  appendAccess(entry: Omit<AccessRecord, "id" | "seq">): Promise<AccessRecord>;
  accessForCase(caseId: string): Promise<AccessRecord[]>;
  accessByCounsellor(counsellorId: string, limit?: number): Promise<AccessRecord[]>;

  // -- overrides ----------------------------------------------------------------------
  putOverride(entry: Omit<OverrideRecord, "id">): Promise<OverrideRecord>;
  overrideForCase(caseId: string): Promise<OverrideRecord | null>;
  allOverrides(): Promise<OverrideRecord[]>;

  // -- break-glass --------------------------------------------------------------------
  appendBreakGlass(entry: Omit<BreakGlassRecord, "id">): Promise<BreakGlassRecord>;
  breakGlassById(id: string): Promise<BreakGlassRecord | null>;
  breakGlassForCase(caseId: string): Promise<BreakGlassRecord[]>;
  unreviewedBreakGlass(): Promise<BreakGlassRecord[]>;
  reviewBreakGlass(input: {
    id: string;
    reviewedBy: string;
    reviewedAt: string;
    reviewNote: string;
  }): Promise<BreakGlassRecord | null>;

  // -- live conversations ---------------------------------------------------------------
  /**
   * Write (or rewrite) a live conversation, its turns and its card.
   *
   * The whole transcript is rewritten each turn rather than appended to. The client
   * resends its full history on every message, so a rewrite is the operation that
   * actually matches the input — and it makes a retried or half-failed request converge
   * instead of duplicating turns.
   */
  upsertLiveConversation(input: LiveConversationInput): Promise<void>;

  /**
   * Overwrite a stored card with a scored one, leaving the transcript alone.
   *
   * Separate from `upsertLiveConversation` because it must NOT touch turns: those are
   * already redacted and sealed, and rewriting them would re-encrypt spans for no gain.
   */
  upsertScoredCard(input: {
    caseId: string;
    tier: Tier;
    confidence: number | null;
    tierFloorReason: string | null;
    retentionExpiresAt: string | null;
    card: EscalationCard;
  }): Promise<void>;

  /** Cards for conversations that happened here, newest first. Excludes seeded rows. */
  liveCards(): Promise<EscalationCard[]>;

  liveCard(caseId: string): Promise<EscalationCard | null>;

  // -- retention ----------------------------------------------------------------------
  /** Every conversation whose content still exists, for the sweep to filter. */
  retentionCandidates(): Promise<RetentionRecord[]>;
  /**
   * Erase this conversation's turns and PII map, and stamp `contentDeletedAt`.
   *
   * The conversation row survives as a tombstone carrying the case id and the date. The
   * access log is untouched: it is keyed on `case_id` with no foreign key precisely so
   * this call cannot reach it.
   */
  deleteConversationContent(caseId: string, at: string): Promise<void>;
  upsertRetentionRecord(record: RetentionRecord): Promise<void>;
}
