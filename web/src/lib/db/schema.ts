/**
 * Drizzle schema for Lighthouse.
 *
 * ## The privacy design is in the column layout, not in a policy document
 *
 * `docs/context.md` §11 promises pseudonymity, redaction before storage, tiered
 * disclosure, and an audit log. Those promises are only real if the schema makes the
 * alternative awkward, so:
 *
 * - There is **no student `name`, `email`, or `school` column anywhere.** The student is
 *   a handle. There is nothing to leak because nothing was collected.
 * - `turns.text` holds the **redacted** transcript. The un-redacted spans live in
 *   `pii_map`, encrypted, keyed separately, and joined only on escalation.
 * - `counsellor_access` is append-only and every read of a case writes a row. A
 *   counsellor cannot look at a case without leaving a record the student can see.
 *
 * ## Two things day 8 changed, and why
 *
 * **The audit tables no longer cascade.** They previously carried
 * `conversation_id uuid references conversations(id) on delete cascade`, which meant the
 * retention job deleting a conversation also deleted every record of who had opened it.
 * An audit log that a routine cleanup job can erase is not an audit log. They now key on
 * `case_id text` with no foreign key: retention removes the *content*, and the record of
 * who looked at it survives as a tombstone.
 *
 * **The actor's identity is denormalised into every audit row.** `counsellor_email` is
 * copied in at write time rather than joined from `counsellors`. An audit record whose
 * meaning depends on a mutable row elsewhere can be rewritten by editing that row, and
 * "who was this" has to stay answerable after the account is deleted.
 */

import { relations } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Mirrors `Tier` in `lib/taxonomy.ts` and `ml/lighthouse/taxonomy.py`. */
export const tierEnum = pgEnum("tier", ["T0", "T1", "T2", "T3", "T4"]);

export const roleEnum = pgEnum("turn_role", ["student", "assistant"]);

export const gateLevelEnum = pgEnum("gate_level", ["clear", "grey", "high"]);

// ---------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * The stable public identifier, e.g. `syn-042`. Distinct from `id` on purpose.
     *
     * This is what appears in a URL, in an audit row, and in a counsellor's notes, so it
     * has to outlive the row. `id` is a database key and dies with the record; `case_id`
     * is a reference that stays meaningful after the retention job has deleted everything
     * it pointed at.
     */
    caseId: text("case_id").notNull().unique(),

    /**
     * Student-chosen pseudonym. Not unique: two students may both pick "bluefox", and
     * forcing uniqueness would leak the existence of the other one.
     */
    handle: text("handle").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /**
     * Set only once the classifier has run. Null means "not yet triaged", which is
     * different from T0 and must stay distinguishable.
     */
    tier: tierEnum("tier"),
    confidence: real("confidence"),

    /** Populated when the gate floored the tier. Renders on the escalation card. */
    tierFloorReason: text("tier_floor_reason"),
    gateLevel: gateLevelEnum("gate_level"),
    gateIndicators: jsonb("gate_indicators").$type<string[]>().default([]),

    /** True when crisis numbers were rendered. Auditable: we can prove they were shown. */
    crisisResourcesShown: boolean("crisis_resources_shown").notNull().default(false),

    /**
     * When the retention job may delete this. `null` on escalated cases, which are
     * exempt (see `ESCALATED_TIERS`). A nullable column rather than a computed one so a
     * counsellor extending retention leaves a visible change.
     */
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),

    /**
     * Set when the retention job has erased this conversation's content. The row itself
     * stays, holding only the case id, the tier and this timestamp.
     *
     * A tombstone rather than a `DELETE` because the audit log references the case id: a
     * counsellor asking "what happened to syn-042" must get "deleted on this date under
     * the 30-day policy" and not a blank. Erasure of content and erasure of the fact that
     * something existed are different promises, and only the first one was made.
     */
    contentDeletedAt: timestamp("content_deleted_at", { withTimezone: true }),

    /**
     * Why this conversation is exempt from deletion, e.g. an active safeguarding case.
     * Nullable text rather than a boolean so an extension has to be justified in writing.
     */
    retentionHoldReason: text("retention_hold_reason"),

    /**
     * The escalation card for a live conversation, as JSON.
     *
     * Stored rather than derived, for the same reason the seeded cards are compiled in:
     * the counsellor console must render without depending on a classifier being awake.
     * A card is written the moment the conversation is, built from the safety gate alone
     * and marked `awaitingClassifier`; when the scoring service answers, the richer card
     * replaces it in place. The queue reads this column either way and does not know or
     * care which kind it got.
     *
     * Null on the seeded rows, whose cards are compiled into the bundle instead.
     */
    card: jsonb("card"),

    /** Set by day 7's clustering. Null until then, and null for unlinked cases. */
    patternClusterId: uuid("pattern_cluster_id"),
  },
  (table) => [
    // The counsellor queue reads by tier and recency. Without this it table-scans.
    index("conversations_tier_started_idx").on(table.tier, table.startedAt),
    index("conversations_handle_idx").on(table.handle),
    index("conversations_retention_idx").on(table.retentionExpiresAt),
  ],
);

// ---------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),

    /** Position in the transcript. The classifier's trend features depend on this order. */
    ordinal: integer("ordinal").notNull(),
    role: roleEnum("role").notNull(),

    /**
     * REDACTED text. Never write a raw student turn here.
     *
     * The escalation card quotes verbatim from this column, which is why
     * `gate/patterns.ts:normalize` is length-preserving: a quote's offsets have to survive
     * from the gate all the way to the counsellor's screen.
     */
    text: text("text").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Calibrated per-turn harm probabilities from the DistilBERT classifier, indexed by
     * `HARM_ORDER`. Stored rather than recomputed so the counsellor console never depends
     * on the HF Space being awake (context.md §9, the two-runtime mitigation).
     */
    harmProbs: jsonb("harm_probs").$type<number[]>(),

    /** Per-turn gate hits, for highlighting inside the transcript view. */
    gateHits: jsonb("gate_hits").$type<{ category: string; pattern: string }[]>(),
  },
  (table) => [index("turns_conversation_ordinal_idx").on(table.conversationId, table.ordinal)],
);

// ---------------------------------------------------------------------------------------
// PII map — the only place identifying spans exist
// ---------------------------------------------------------------------------------------

export const piiMap = pgTable(
  "pii_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),

    /** `person`, `place`, `platform`, `phone`, … Not sensitive on its own. */
    entityType: text("entity_type").notNull(),

    /** The token that replaced it in `turns.text`, e.g. `[REDACTED person]`. */
    placeholder: text("placeholder").notNull(),

    /**
     * The original span, ENCRYPTED. Day 8 supplies the key, held outside the database so
     * a database dump alone does not de-anonymise a child.
     */
    ciphertext: text("ciphertext").notNull(),

    /** Unlocked only on escalation, and only with a logged reason. */
    unsealedAt: timestamp("unsealed_at", { withTimezone: true }),
    unsealedBy: uuid("unsealed_by"),
    unsealReason: text("unseal_reason"),
  },
  (table) => [index("pii_map_conversation_idx").on(table.conversationId)],
);

// ---------------------------------------------------------------------------------------
// Counsellors — the only people in this database with names
// ---------------------------------------------------------------------------------------

/**
 * `counsellor` works the queue. `lead` is the designated safeguarding lead and is the only
 * role that can review a break-glass closure.
 *
 * Deliberately NOT a permission gate on the urgent path: a lead is who *reviews* an
 * emergency action, never who has to be found before one can be taken. See
 * `lib/breakglass.ts`.
 */
export const counsellorRoleEnum = pgEnum("counsellor_role", ["counsellor", "lead"]);

export const counsellors = pgTable(
  "counsellors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),

    /**
     * `scrypt$N$r$p$<salt>$<hash>`, produced by `lib/auth/password.ts`.
     *
     * Self-describing so the work factor can be raised later without a flag day: an old
     * row carries the parameters it was written with, and a successful login against an
     * outdated one triggers a rehash.
     */
    passwordHash: text("password_hash").notNull(),

    role: counsellorRoleEnum("role").notNull().default("counsellor"),

    /** Soft disable. Revokes sessions without destroying the audit trail's subject. */
    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [index("counsellors_email_idx").on(table.email)],
);

export const counsellorSessions = pgTable(
  "counsellor_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counsellorId: uuid("counsellor_id")
      .notNull()
      .references(() => counsellors.id, { onDelete: "cascade" }),

    /**
     * SHA-256 of the session token. **The token itself is never stored.**
     *
     * A stolen database therefore yields no usable sessions, which matters more here than
     * in a typical app: a session on this system reads children's disclosures. Unique so a
     * (vanishingly unlikely) collision is a write error rather than a silent account swap.
     */
    tokenHash: text("token_hash").notNull().unique(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** Set on sign-out or forced revocation. Kept rather than deleted, so it is auditable. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("counsellor_sessions_token_idx").on(table.tokenHash),
    index("counsellor_sessions_counsellor_idx").on(table.counsellorId),
  ],
);

// ---------------------------------------------------------------------------------------
// Counsellor access log — append only, and it outlives the thing it describes
// ---------------------------------------------------------------------------------------

export const counsellorAccess = pgTable(
  "counsellor_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Insertion order, as a tie-break for `at`.
     *
     * Two actions in the same millisecond are ordinary — opening a case writes a
     * `viewed_card` row and a break-glass immediately after writes another — and without
     * this the log came back ordered by random UUID. A student reading "who opened my
     * case" must see the events in the order they happened, and "usually right" is not a
     * property an audit log gets to have.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),

    /** Text, and no foreign key. See the file header: retention must not erase the log. */
    caseId: text("case_id").notNull(),

    counsellorId: uuid("counsellor_id").notNull(),

    /** Denormalised at write time so the row stays readable after the account is gone. */
    counsellorEmail: text("counsellor_email").notNull(),

    /**
     * `viewed_card` | `viewed_transcript` | `unsealed_pii` | `overrode_tier` |
     * `broke_glass` | `reviewed_break_glass`.
     *
     * All case-scoped. Sign-in is not in this list: it belongs to no case, and
     * `counsellor_sessions` already records when each session began and ended.
     */
    action: text("action").notNull(),

    /** Mandatory on `unsealed_pii` and `broke_glass`. Enforced in the write path. */
    reason: text("reason"),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("counsellor_access_case_idx").on(table.caseId, table.at, table.seq),
    index("counsellor_access_counsellor_idx").on(table.counsellorId, table.at),
  ],
);

// ---------------------------------------------------------------------------------------
// Tier overrides — the counsellor's correction, kept as training signal
// ---------------------------------------------------------------------------------------

export const tierOverrides = pgTable(
  "tier_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: text("case_id").notNull(),
    counsellorId: uuid("counsellor_id").notNull(),
    counsellorEmail: text("counsellor_email").notNull(),

    predictedTier: tierEnum("predicted_tier").notNull(),

    /** What the counsellor asked for. */
    requestedTier: tierEnum("requested_tier").notNull(),

    /**
     * What they got, after `applyFloor` re-ran over the request.
     *
     * Both are stored because the gap between them is the interesting signal: a counsellor
     * repeatedly asking for T1 on cases the gate floors at T4 is either a gate that is too
     * eager or a counsellor who needs support, and you cannot tell which from the
     * effective tier alone.
     */
    effectiveTier: tierEnum("effective_tier").notNull(),

    reason: text("reason").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tier_overrides_case_idx").on(table.caseId, table.at)],
);

// ---------------------------------------------------------------------------------------
// Break-glass — the escape hatch, and the record it leaves
// ---------------------------------------------------------------------------------------

/**
 * A counsellor closing a case the gate floors above their judgement.
 *
 * This is the one path that overrules the safety gate, so it is a separate table rather
 * than a flag on `tier_overrides`. It is not "an override with a longer reason": it is a
 * different act, it is rare, and it should be countable. A query answering "how often was
 * the gate overruled last term, by whom, and did a lead ever look" has to be one SELECT.
 */
export const breakGlass = pgTable(
  "break_glass",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: text("case_id").notNull(),
    counsellorId: uuid("counsellor_id").notNull(),
    counsellorEmail: text("counsellor_email").notNull(),

    /** The floor that was overruled. Null is not valid: there is nothing to break. */
    gateFloor: tierEnum("gate_floor").notNull(),
    closedAtTier: tierEnum("closed_at_tier").notNull(),

    reason: text("reason").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Review by the safeguarding lead, after the fact.
     *
     * After, not before. Requiring a second person up front would mean a counsellor at
     * 7pm on a Friday either waits or works around the system, and the second of those is
     * what actually happens. The control is that every one of these rows is unreviewed
     * until a lead clears it, and the console shows the unreviewed count.
     */
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
  },
  (table) => [
    index("break_glass_case_idx").on(table.caseId),
    index("break_glass_reviewed_idx").on(table.reviewedAt),
  ],
);

// ---------------------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------------------

export const conversationRelations = relations(conversations, ({ many }) => ({
  turns: many(turns),
  piiEntries: many(piiMap),
}));

export const turnRelations = relations(turns, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [turns.conversationId],
    references: [conversations.id],
  }),
  piiEntries: many(piiMap),
}));

export const counsellorRelations = relations(counsellors, ({ many }) => ({
  sessions: many(counsellorSessions),
}));

export const sessionRelations = relations(counsellorSessions, ({ one }) => ({
  counsellor: one(counsellors, {
    fields: [counsellorSessions.counsellorId],
    references: [counsellors.id],
  }),
}));

export type Conversation = typeof conversations.$inferSelect;
export type Turn = typeof turns.$inferSelect;
export type Counsellor = typeof counsellors.$inferSelect;
export type CounsellorRole = Counsellor["role"];
