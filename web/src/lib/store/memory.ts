/**
 * The in-memory store: for tests, and for a local run with no database.
 *
 * `createMemoryStore()` returns a fresh, isolated instance every call, which is the point.
 * A module-level singleton would leak state between test files and produce the classic
 * "passes alone, fails in the suite" ordering bug — and this is a suite whose whole job is
 * asserting that a record was written exactly once.
 *
 * It implements the same semantics as `postgres.ts`, including the ones that are easy to
 * get subtly wrong: emails match case-insensitively, `putOverride` replaces the previous
 * override for a case rather than accumulating, and every list comes back in a defined
 * order. Where the two implementations disagree, this file is wrong, because production
 * runs on Postgres.
 */

import { randomUUID } from "node:crypto";

import type {
  AccessRecord,
  BreakGlassRecord,
  CounsellorRecord,
  OverrideRecord,
  RetentionRecord,
  SessionRecord,
  Store,
} from "@/lib/store/types";

export function createMemoryStore(): Store {
  const counsellors = new Map<string, CounsellorRecord>();
  const conversations = new Map<string, RetentionRecord>();
  const sessions = new Map<string, SessionRecord>();
  const access: AccessRecord[] = [];
  let accessSeq = 0;
  const overrides = new Map<string, OverrideRecord>();
  const breakGlass: BreakGlassRecord[] = [];

  const norm = (email: string) => email.trim().toLowerCase();

  return {
    kind: "memory",

    async counsellorByEmail(email) {
      const target = norm(email);
      return [...counsellors.values()].find((c) => norm(c.email) === target) ?? null;
    },

    async counsellorById(id) {
      return counsellors.get(id) ?? null;
    },

    async createCounsellor(input) {
      const email = norm(input.email);
      if ([...counsellors.values()].some((c) => norm(c.email) === email)) {
        throw new Error(`a counsellor with the email ${email} already exists`);
      }
      const record: CounsellorRecord = {
        id: randomUUID(),
        email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role: input.role ?? "counsellor",
        active: true,
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
      };
      counsellors.set(record.id, record);
      return record;
    },

    async updatePasswordHash(id, passwordHash) {
      const c = counsellors.get(id);
      if (c) counsellors.set(id, { ...c, passwordHash });
    },

    async touchCounsellor(id, at) {
      const c = counsellors.get(id);
      if (c) counsellors.set(id, { ...c, lastSeenAt: at });
    },

    async listCounsellors() {
      return [...counsellors.values()].sort((a, b) =>
        a.email < b.email ? -1 : a.email > b.email ? 1 : 0,
      );
    },

    async setCounsellorActive(id, active) {
      const c = counsellors.get(id);
      if (c) counsellors.set(id, { ...c, active });
    },

    async createSession(input) {
      const record: SessionRecord = {
        id: randomUUID(),
        counsellorId: input.counsellorId,
        tokenHash: input.tokenHash,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        revokedAt: null,
      };
      sessions.set(input.tokenHash, record);
      return record;
    },

    async sessionByTokenHash(tokenHash) {
      return sessions.get(tokenHash) ?? null;
    },

    async revokeSession(tokenHash, at) {
      const s = sessions.get(tokenHash);
      // Revoked rather than deleted, matching Postgres. "This session was ended, and when"
      // is a different fact from "this session never existed".
      if (s && !s.revokedAt) sessions.set(tokenHash, { ...s, revokedAt: at });
    },

    async revokeSessionsFor(counsellorId, at) {
      for (const [hash, s] of sessions) {
        if (s.counsellorId === counsellorId && !s.revokedAt) {
          sessions.set(hash, { ...s, revokedAt: at });
        }
      }
    },

    async appendAccess(entry) {
      const record: AccessRecord = { id: randomUUID(), seq: ++accessSeq, ...entry };
      access.push(record);
      return record;
    },

    async accessForCase(caseId) {
      return access.filter((e) => e.caseId === caseId).sort(byTimeThenSeq);
    },

    async accessByCounsellor(counsellorId, limit = 100) {
      return access
        .filter((e) => e.counsellorId === counsellorId)
        .sort((a, b) => -byTimeThenSeq(a, b))
        .slice(0, limit);
    },

    async putOverride(entry) {
      const record: OverrideRecord = { id: randomUUID(), ...entry };
      overrides.set(entry.caseId, record);
      return record;
    },

    async overrideForCase(caseId) {
      return overrides.get(caseId) ?? null;
    },

    async allOverrides() {
      return [...overrides.values()].sort(byTimeThenId);
    },

    async appendBreakGlass(entry) {
      const record: BreakGlassRecord = { id: randomUUID(), ...entry };
      breakGlass.push(record);
      return record;
    },

    async breakGlassById(id) {
      return breakGlass.find((b) => b.id === id) ?? null;
    },

    async breakGlassForCase(caseId) {
      return breakGlass.filter((b) => b.caseId === caseId).sort(byTimeThenId);
    },

    async unreviewedBreakGlass() {
      return breakGlass.filter((b) => b.reviewedAt === null).sort(byTimeThenId);
    },

    async reviewBreakGlass(input) {
      const i = breakGlass.findIndex((b) => b.id === input.id);
      if (i === -1) return null;
      // Only ever fills in nulls. A review cannot be revised, and cannot touch the reason
      // or the tiers, so the account of what happened stays the one written at the time.
      if (breakGlass[i].reviewedAt !== null) return breakGlass[i];
      breakGlass[i] = {
        ...breakGlass[i],
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        reviewNote: input.reviewNote,
      };
      return breakGlass[i];
    },

    async retentionCandidates() {
      return [...conversations.values()].sort((a, b) =>
        a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0,
      );
    },

    async deleteConversationContent(caseId, at) {
      const c = conversations.get(caseId);
      if (!c || c.contentDeletedAt) return;
      conversations.set(caseId, { ...c, contentDeletedAt: at });
      // The Postgres store deletes rows from `turns` and `pii_map` here. This store never
      // held them, so the tombstone is the whole of it — and the access log is deliberately
      // not touched by either.
    },

    async upsertRetentionRecord(record) {
      conversations.set(record.caseId, { ...record });
    },
  };
}

/**
 * Chronological, with insertion order as the tie-break.
 *
 * Two rows sharing a millisecond is normal, not a test artefact: opening a case and acting
 * on it happen in the same tick. Falling back to the id would order them by random UUID.
 */
function byTimeThenSeq(
  a: { at: string; seq: number },
  b: { at: string; seq: number },
): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq;
}

/** For the tables where rows carry no sequence. Rare enough that the id tie-break holds. */
function byTimeThenId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
