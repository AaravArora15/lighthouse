/**
 * Drizzle schema for Lighthouse.
 *
 * **Written but not pushed.** There is no `DATABASE_URL` in this environment yet, so no
 * migration has been generated and nothing has been created in Neon. The day 5 chat runs
 * against an in-memory store (`lib/db/store.ts`) that implements the same shape, so
 * swapping it for real persistence is a driver change, not a rewrite.
 *
 * ## The privacy design is in the column layout, not in a policy document
 *
 * `docs/context.md` §11 promises pseudonymity, redaction before storage, tiered
 * disclosure, and an audit log. Those promises are only real if the schema makes the
 * alternative awkward, so:
 *
 * - There is **no `name`, `email`, or `school` column anywhere.** The student is a
 *   handle. There is nothing to leak because nothing was collected.
 * - `turns.text` holds the **redacted** transcript. The un-redacted spans live in
 *   `pii_map`, encrypted, keyed separately, and joined only on escalation.
 * - `counsellor_access` is append-only and every read of a transcript writes a row. A
 *   counsellor cannot look at a case without leaving a record the student can see.
 *
 * Day 8 builds the redaction pipeline and the encryption; this file is the shape it has
 * to fit into, so the two cannot drift.
 */

import { relations } from "drizzle-orm";
import {
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
// Counsellor access log — append only
// ---------------------------------------------------------------------------------------

export const counsellorAccess = pgTable(
  "counsellor_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),

    counsellorId: uuid("counsellor_id").notNull(),

    /** `viewed_card` | `viewed_transcript` | `unsealed_pii` | `overrode_tier` | `broke_glass`. */
    action: text("action").notNull(),

    /** Mandatory on `unsealed_pii` and `broke_glass`. Enforced in the write path. */
    reason: text("reason"),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("counsellor_access_conversation_idx").on(table.conversationId, table.at),
    index("counsellor_access_counsellor_idx").on(table.counsellorId, table.at),
  ],
);

// ---------------------------------------------------------------------------------------
// Tier overrides — the counsellor's correction, kept as training signal
// ---------------------------------------------------------------------------------------

export const tierOverrides = pgTable("tier_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  counsellorId: uuid("counsellor_id").notNull(),

  predictedTier: tierEnum("predicted_tier").notNull(),
  overrideTier: tierEnum("override_tier").notNull(),
  reason: text("reason").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------------------

export const conversationRelations = relations(conversations, ({ many }) => ({
  turns: many(turns),
  piiEntries: many(piiMap),
  accesses: many(counsellorAccess),
  overrides: many(tierOverrides),
}));

export const turnRelations = relations(turns, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [turns.conversationId],
    references: [conversations.id],
  }),
  piiEntries: many(piiMap),
}));

export type Conversation = typeof conversations.$inferSelect;
export type Turn = typeof turns.$inferSelect;
