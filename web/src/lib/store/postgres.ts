/**
 * The Postgres store, over Neon's HTTP driver.
 *
 * HTTP rather than a pooled TCP connection because the app runs on serverless functions
 * that may be frozen mid-request: each query is a stateless fetch, so there is no
 * connection to leak and no pool to exhaust when traffic arrives in bursts. The tradeoff
 * is no interactive transactions, which this schema does not need — every write here is a
 * single statement, and the append-only tables have nothing to roll back.
 *
 * ## Timestamps cross the boundary as ISO strings
 *
 * Drizzle hands back `Date` objects; the `Store` interface says `string`. The conversion
 * happens here, in one direction, at the edge. Letting `Date` through would mean two
 * stores returning different types for the same field and a whole class of bug that only
 * appears in deployment, which is precisely the thing the shared interface exists to stop.
 */

import { neon } from "@neondatabase/serverless";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";

import {
  breakGlass,
  conversations,
  counsellorAccess,
  counsellorSessions,
  counsellors,
  piiMap,
  tierOverrides,
  turns,
} from "@/lib/db/schema";
import type { EscalationCard } from "@/lib/cards";
import type {
  AccessRecord,
  BreakGlassRecord,
  CounsellorRecord,
  OverrideRecord,
  SessionRecord,
  Store,
} from "@/lib/store/types";
import type { Tier } from "@/lib/taxonomy";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function createPostgresStore(url: string): Store {
  const db = drizzle(neon(url));

  const toCounsellor = (r: typeof counsellors.$inferSelect): CounsellorRecord => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    passwordHash: r.passwordHash,
    role: r.role,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: iso(r.lastSeenAt),
  });

  const toSession = (r: typeof counsellorSessions.$inferSelect): SessionRecord => ({
    id: r.id,
    counsellorId: r.counsellorId,
    tokenHash: r.tokenHash,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: iso(r.revokedAt),
  });

  const toAccess = (r: typeof counsellorAccess.$inferSelect): AccessRecord => ({
    id: r.id,
    seq: Number(r.seq),
    caseId: r.caseId,
    counsellorId: r.counsellorId,
    counsellorEmail: r.counsellorEmail,
    action: r.action as AccessRecord["action"],
    reason: r.reason,
    at: r.at.toISOString(),
  });

  const toBreakGlass = (r: typeof breakGlass.$inferSelect): BreakGlassRecord => ({
    id: r.id,
    caseId: r.caseId,
    counsellorId: r.counsellorId,
    counsellorEmail: r.counsellorEmail,
    gateFloor: r.gateFloor as Tier,
    closedAtTier: r.closedAtTier as Tier,
    reason: r.reason,
    at: r.at.toISOString(),
    reviewedBy: r.reviewedBy,
    reviewedAt: iso(r.reviewedAt),
    reviewNote: r.reviewNote,
  });

  return {
    kind: "postgres",

    async counsellorByEmail(email) {
      // Lower-cased on both sides: an account is a person, not a capitalisation.
      const [row] = await db
        .select()
        .from(counsellors)
        .where(sql`lower(${counsellors.email}) = ${email.trim().toLowerCase()}`)
        .limit(1);
      return row ? toCounsellor(row) : null;
    },

    async counsellorById(id) {
      const [row] = await db.select().from(counsellors).where(eq(counsellors.id, id)).limit(1);
      return row ? toCounsellor(row) : null;
    },

    async createCounsellor(input) {
      const [row] = await db
        .insert(counsellors)
        .values({
          email: input.email.trim().toLowerCase(),
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          role: input.role ?? "counsellor",
        })
        .returning();
      return toCounsellor(row);
    },

    async updatePasswordHash(id, passwordHash) {
      await db.update(counsellors).set({ passwordHash }).where(eq(counsellors.id, id));
    },

    async touchCounsellor(id, at) {
      await db
        .update(counsellors)
        .set({ lastSeenAt: new Date(at) })
        .where(eq(counsellors.id, id));
    },

    async listCounsellors() {
      const rows = await db.select().from(counsellors).orderBy(counsellors.email);
      return rows.map(toCounsellor);
    },

    async setCounsellorActive(id, active) {
      await db.update(counsellors).set({ active }).where(eq(counsellors.id, id));
    },

    async createSession(input) {
      const [row] = await db
        .insert(counsellorSessions)
        .values({
          counsellorId: input.counsellorId,
          tokenHash: input.tokenHash,
          expiresAt: new Date(input.expiresAt),
        })
        .returning();
      return toSession(row);
    },

    async sessionByTokenHash(tokenHash) {
      const [row] = await db
        .select()
        .from(counsellorSessions)
        .where(eq(counsellorSessions.tokenHash, tokenHash))
        .limit(1);
      return row ? toSession(row) : null;
    },

    async revokeSession(tokenHash, at) {
      await db
        .update(counsellorSessions)
        .set({ revokedAt: new Date(at) })
        .where(
          and(
            eq(counsellorSessions.tokenHash, tokenHash),
            isNull(counsellorSessions.revokedAt),
          ),
        );
    },

    async revokeSessionsFor(counsellorId, at) {
      await db
        .update(counsellorSessions)
        .set({ revokedAt: new Date(at) })
        .where(
          and(
            eq(counsellorSessions.counsellorId, counsellorId),
            isNull(counsellorSessions.revokedAt),
          ),
        );
    },

    async appendAccess(entry) {
      const [row] = await db
        .insert(counsellorAccess)
        .values({
          caseId: entry.caseId,
          counsellorId: entry.counsellorId,
          counsellorEmail: entry.counsellorEmail,
          action: entry.action,
          reason: entry.reason,
          at: new Date(entry.at),
        })
        .returning();
      return toAccess(row);
    },

    async accessForCase(caseId) {
      const rows = await db
        .select()
        .from(counsellorAccess)
        .where(eq(counsellorAccess.caseId, caseId))
        .orderBy(counsellorAccess.at, counsellorAccess.seq);
      return rows.map(toAccess);
    },

    async accessByCounsellor(counsellorId, limit = 100) {
      const rows = await db
        .select()
        .from(counsellorAccess)
        .where(eq(counsellorAccess.counsellorId, counsellorId))
        .orderBy(desc(counsellorAccess.at), desc(counsellorAccess.seq))
        .limit(limit);
      return rows.map(toAccess);
    },

    async putOverride(entry) {
      // Overrides are versioned rather than updated: every attempt is inserted, and
      // `overrideForCase` reads the newest. A counsellor changing their mind twice is
      // three data points about the model, and UPDATE would keep only the last one.
      const [row] = await db
        .insert(tierOverrides)
        .values({
          caseId: entry.caseId,
          counsellorId: entry.counsellorId,
          counsellorEmail: entry.counsellorEmail,
          predictedTier: entry.predictedTier,
          requestedTier: entry.requestedTier,
          effectiveTier: entry.effectiveTier,
          reason: entry.reason,
          at: new Date(entry.at),
        })
        .returning();
      return { ...entry, id: row.id };
    },

    async overrideForCase(caseId) {
      const [row] = await db
        .select()
        .from(tierOverrides)
        .where(eq(tierOverrides.caseId, caseId))
        .orderBy(desc(tierOverrides.at))
        .limit(1);
      return row ? toOverride(row) : null;
    },

    async allOverrides() {
      const rows = await db.select().from(tierOverrides).orderBy(tierOverrides.at);
      return rows.map(toOverride);
    },

    async appendBreakGlass(entry) {
      const [row] = await db
        .insert(breakGlass)
        .values({
          caseId: entry.caseId,
          counsellorId: entry.counsellorId,
          counsellorEmail: entry.counsellorEmail,
          gateFloor: entry.gateFloor,
          closedAtTier: entry.closedAtTier,
          reason: entry.reason,
          at: new Date(entry.at),
        })
        .returning();
      return toBreakGlass(row);
    },

    async breakGlassById(id) {
      const [row] = await db.select().from(breakGlass).where(eq(breakGlass.id, id)).limit(1);
      return row ? toBreakGlass(row) : null;
    },

    async breakGlassForCase(caseId) {
      const rows = await db
        .select()
        .from(breakGlass)
        .where(eq(breakGlass.caseId, caseId))
        .orderBy(breakGlass.at);
      return rows.map(toBreakGlass);
    },

    async unreviewedBreakGlass() {
      const rows = await db
        .select()
        .from(breakGlass)
        .where(isNull(breakGlass.reviewedAt))
        .orderBy(breakGlass.at);
      return rows.map(toBreakGlass);
    },

    async reviewBreakGlass(input) {
      // `isNull(reviewedAt)` in the WHERE makes this a no-op on an already-reviewed row
      // in the database itself, rather than relying on the caller having checked first.
      const [row] = await db
        .update(breakGlass)
        .set({
          reviewedBy: input.reviewedBy,
          reviewedAt: new Date(input.reviewedAt),
          reviewNote: input.reviewNote,
        })
        .where(and(eq(breakGlass.id, input.id), isNull(breakGlass.reviewedAt)))
        .returning();
      if (row) return toBreakGlass(row);

      const [existing] = await db
        .select()
        .from(breakGlass)
        .where(eq(breakGlass.id, input.id))
        .limit(1);
      return existing ? toBreakGlass(existing) : null;
    },

    async upsertLiveConversation(input) {
      const [row] = await db
        .insert(conversations)
        .values({
          caseId: input.caseId,
          handle: input.handle,
          startedAt: new Date(input.startedAt),
          tier: input.tier ?? undefined,
          confidence: input.confidence,
          tierFloorReason: input.tierFloorReason,
          gateLevel: input.gateLevel ?? undefined,
          gateIndicators: input.gateIndicators,
          crisisResourcesShown: input.crisisResourcesShown,
          retentionExpiresAt: input.retentionExpiresAt
            ? new Date(input.retentionExpiresAt)
            : null,
          card: input.card,
        })
        .onConflictDoUpdate({
          target: conversations.caseId,
          set: {
            tier: input.tier ?? undefined,
            confidence: input.confidence,
            tierFloorReason: input.tierFloorReason,
            gateLevel: input.gateLevel ?? undefined,
            gateIndicators: input.gateIndicators,
            // Latched, never cleared. Once a student has seen crisis numbers, a later
            // calm turn does not make that untrue, and the console must keep saying so.
            crisisResourcesShown: sql`${conversations.crisisResourcesShown} or ${input.crisisResourcesShown}`,
            retentionExpiresAt: input.retentionExpiresAt
              ? new Date(input.retentionExpiresAt)
              : null,
            card: input.card,
          },
        })
        .returning({ id: conversations.id });

      // Rewrite, matching the memory store and the interface contract. pii_map cascades
      // from turns, so the sealed spans go with the text they belonged to.
      await db.delete(turns).where(eq(turns.conversationId, row.id));

      for (const turn of input.turns) {
        const [turnRow] = await db
          .insert(turns)
          .values({
            conversationId: row.id,
            ordinal: turn.ordinal,
            role: turn.role,
            text: turn.text,
          })
          .returning({ id: turns.id });

        for (const span of turn.spans) {
          await db.insert(piiMap).values({
            conversationId: row.id,
            turnId: turnRow.id,
            entityType: span.entityType,
            placeholder: span.placeholder,
            ciphertext: span.ciphertext,
          });
        }
      }
    },

    async upsertScoredCard(input) {
      await db
        .update(conversations)
        .set({
          tier: input.tier,
          confidence: input.confidence,
          tierFloorReason: input.tierFloorReason,
          retentionExpiresAt: input.retentionExpiresAt
            ? new Date(input.retentionExpiresAt)
            : null,
          card: input.card,
        })
        .where(eq(conversations.caseId, input.caseId));
    },

    async liveCards() {
      const rows = await db
        .select({ card: conversations.card })
        .from(conversations)
        .where(and(isNotNull(conversations.card), isNull(conversations.contentDeletedAt)))
        .orderBy(desc(conversations.startedAt));
      return rows.map((r) => r.card as EscalationCard);
    },

    async liveCard(caseId) {
      const [row] = await db
        .select({ card: conversations.card })
        .from(conversations)
        .where(eq(conversations.caseId, caseId))
        .limit(1);
      return (row?.card as EscalationCard | undefined) ?? null;
    },

    async turnsForCase(caseId) {
      const rows = await db
        .select({ ordinal: turns.ordinal, role: turns.role, text: turns.text })
        .from(turns)
        .innerJoin(conversations, eq(turns.conversationId, conversations.id))
        .where(eq(conversations.caseId, caseId))
        .orderBy(turns.ordinal);
      return rows.map((r) => ({ ordinal: r.ordinal, role: r.role as string, text: r.text }));
    },

    async retentionCandidates() {
      const rows = await db
        .select({
          caseId: conversations.caseId,
          tier: conversations.tier,
          startedAt: conversations.startedAt,
          retentionExpiresAt: conversations.retentionExpiresAt,
          retentionHoldReason: conversations.retentionHoldReason,
          contentDeletedAt: conversations.contentDeletedAt,
        })
        .from(conversations)
        .orderBy(conversations.caseId);
      return rows.map((r) => ({
        caseId: r.caseId,
        tier: (r.tier as Tier | null) ?? null,
        startedAt: r.startedAt.toISOString(),
        retentionExpiresAt: iso(r.retentionExpiresAt),
        retentionHoldReason: r.retentionHoldReason,
        contentDeletedAt: iso(r.contentDeletedAt),
      }));
    },

    async deleteConversationContent(caseId, at) {
      const [row] = await db
        .select({ id: conversations.id, deleted: conversations.contentDeletedAt })
        .from(conversations)
        .where(eq(conversations.caseId, caseId))
        .limit(1);
      if (!row || row.deleted) return;

      // Order matters: pii_map first. It holds the encrypted identifying spans, and
      // `turns` cascades to it, so deleting turns first would remove those rows as a side
      // effect of a statement that does not mention them. Making the erasure explicit is
      // what lets this be pointed at and checked.
      await db.delete(piiMap).where(eq(piiMap.conversationId, row.id));
      await db.delete(turns).where(eq(turns.conversationId, row.id));
      await db
        .update(conversations)
        // The card goes with the content: it quotes the student verbatim, so keeping it
        // would be retaining the disclosure under a different column name.
        .set({ contentDeletedAt: new Date(at), card: null })
        .where(eq(conversations.id, row.id));
      // counsellor_access, tier_overrides and break_glass are untouched. They key on
      // case_id with no foreign key, so this call has no way to reach them.
    },

    async upsertRetentionRecord(record) {
      await db
        .insert(conversations)
        .values({
          caseId: record.caseId,
          handle: "seeded",
          tier: record.tier ?? undefined,
          startedAt: new Date(record.startedAt),
          retentionExpiresAt: record.retentionExpiresAt
            ? new Date(record.retentionExpiresAt)
            : null,
          retentionHoldReason: record.retentionHoldReason,
          contentDeletedAt: record.contentDeletedAt
            ? new Date(record.contentDeletedAt)
            : null,
        })
        .onConflictDoUpdate({
          target: conversations.caseId,
          set: {
            tier: record.tier ?? undefined,
            retentionExpiresAt: record.retentionExpiresAt
              ? new Date(record.retentionExpiresAt)
              : null,
            retentionHoldReason: record.retentionHoldReason,
          },
        });
    },
  };

  function toOverride(r: typeof tierOverrides.$inferSelect): OverrideRecord {
    return {
      id: r.id,
      caseId: r.caseId,
      counsellorId: r.counsellorId,
      counsellorEmail: r.counsellorEmail,
      predictedTier: r.predictedTier as Tier,
      requestedTier: r.requestedTier as Tier,
      effectiveTier: r.effectiveTier as Tier,
      // Derived on read rather than stored: it is a sentence about a comparison the two
      // tier columns already encode, and a stored copy would be a second source of truth.
      flooredNotice:
        r.effectiveTier !== r.requestedTier
          ? `Recorded as ${r.effectiveTier}, not ${r.requestedTier}: the safety gate ` +
            `floors this conversation. Your reason has been logged against it.`
          : null,
      reason: r.reason,
      at: r.at.toISOString(),
    };
  }
}
