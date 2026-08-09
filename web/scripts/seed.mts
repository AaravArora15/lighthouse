/**
 * Seed the demo database from the committed fixtures.
 *
 *     npm run seed          # report what would be written, change nothing
 *     npm run seed -- --write
 *     npm run seed -- --write --reset
 *
 * ## What goes in, and what deliberately does not
 *
 * **In:** `conversations` (one row per synthetic case, carrying the tier, the start date
 * and the retention expiry) and `turns` (the transcript, **redacted**), plus a `pii_map`
 * row holding each redacted span encrypted under `LIGHTHOUSE_PII_KEY`.
 *
 * **Not in:** the escalation cards. Those stay a compiled-in fixture (`src/fixtures/`).
 * `docs/context.md` §9 names the two-runtime risk and its mitigation — the demo ships with
 * classifier scores already computed so it never depends on a free HF Space being awake —
 * and a bundled constant honours that better than a table does. Reading eighty cards from
 * Postgres on every queue render would add a network round trip to the most-viewed page
 * for no benefit, and would give the demo a second way to fail in front of a judge.
 *
 * So the split is: **derived, static, read-every-request -> bundle. Mutable, per-student,
 * subject to retention -> database.**
 *
 * ## This is the first time redaction runs over the whole corpus
 *
 * Day 8 built `privacy/redact.ts` and then found it was inert against real turns, because
 * every name detector wanted a capital letter and students type lowercase. The fix routes
 * names and places through the entity extractor. Nothing had yet run it across all 85
 * conversations, so this script prints the redaction rate rather than assuming one — if
 * that number comes back at zero again, it says so here instead of in the README.
 *
 * ## Idempotent
 *
 * `conversations` upserts on `case_id`; turns and PII rows for a case are deleted and
 * rewritten. Running it twice is a no-op, which matters because the alternative is a demo
 * database with each conversation in it three times.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(join(HERE, "..", ".env.local"));

const { neon } = await import("@neondatabase/serverless");
const { redact } = await import("@/lib/privacy/redact");
const { seal, hasKey } = await import("@/lib/privacy/seal");
const { retentionExpiry } = await import("@/lib/retention");
type Tier = import("@/lib/taxonomy").Tier;

const FIXTURES = join(HERE, "..", "..", "fixtures");
const write = process.argv.includes("--write");
const reset = process.argv.includes("--reset");

interface Card {
  caseId: string;
  handle: string;
  tier: string;
  startedAt: string;
  confidence: number;
  tierFloorReason: string | null;
  gateIndicators: string[];
  crisisResourcesShown: boolean;
}

interface Conversation {
  id: string;
  handle: string;
  turns: { role: "student" | "assistant"; text: string }[];
}

const cards: Card[] = JSON.parse(
  readFileSync(join(FIXTURES, "escalation_cards.json"), "utf8"),
);
const conversations: Conversation[] = readFileSync(
  join(FIXTURES, "synthetic_conversations.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

/**
 * Plaintext people and places per case, from the day 7 extractor.
 *
 * `debug_plaintext` is the un-pseudonymised side of `entities.json`, which exists exactly
 * for this: redaction needs the literal strings to find them in the text, while the
 * clustering layer only ever sees the HMAC tokens. The fixture is synthetic throughout, so
 * there is no real name in it to protect.
 */
const entityFixture = JSON.parse(readFileSync(join(FIXTURES, "entities.json"), "utf8")) as {
  conversations: {
    caseId: string;
    debug_plaintext: { people: string[]; places: string[] };
  }[];
};
const entities = new Map(
  entityFixture.conversations.map((e) => [
    e.caseId,
    { people: e.debug_plaintext.people, places: e.debug_plaintext.places },
  ]),
);

if (!hasKey()) {
  console.error(
    "LIGHTHOUSE_PII_KEY is not set. Refusing to seed: the turns would be written\n" +
      "without their identifying spans sealed, which is the one thing this schema exists\n" +
      "to prevent. Set it in web/.env.local first.",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Nothing to seed.");
  process.exit(1);
}
const sql = neon(url);

const cardById = new Map(cards.map((c) => [c.caseId, c]));

let turnsWritten = 0;
let turnsRedacted = 0;
let spansFound = 0;
let spansSealed = 0;
let casesSeeded = 0;
const bySpanType = new Map<string, number>();

if (write && reset) {
  // Conversations cascade to turns and pii_map. The audit tables are keyed on case_id
  // with no foreign key, so they are deliberately untouched by this — a reseed must not
  // erase the record of who read what any more than the retention job may.
  await sql`delete from conversations`;
  console.log("reset: conversations, turns and pii_map cleared (audit log untouched)\n");
}

for (const conversation of conversations) {
  const card = cardById.get(conversation.id);
  if (!card) continue;

  const known = entities.get(conversation.id) ?? { people: [], places: [] };

  // Redact every turn up front, so a dry run reports the real numbers.
  const redactedTurns = conversation.turns.map((turn) => {
    // Only student turns carry disclosures. The assistant's replies are ours and contain
    // nothing a student wrote, but they go through the same call rather than being
    // exempted: an exemption is a branch that stops being true the moment the assistant
    // starts quoting the student back.
    const result = redact(turn.text, known);
    if (result.spans.length > 0) {
      turnsRedacted += 1;
      for (const span of result.spans) {
        bySpanType.set(span.type, (bySpanType.get(span.type) ?? 0) + 1);
      }
    }
    spansFound += result.spans.length;
    turnsWritten += 1;
    return { role: turn.role, ...result };
  });

  casesSeeded += 1;
  if (!write) continue;

  const expiry = retentionExpiry(card.startedAt, card.tier as Tier);

  const [row] = await sql`
    insert into conversations
      (case_id, handle, tier, confidence, started_at, tier_floor_reason,
       gate_indicators, crisis_resources_shown, retention_expires_at)
    values
      (${card.caseId}, ${card.handle}, ${card.tier}, ${card.confidence},
       ${card.startedAt}, ${card.tierFloorReason},
       ${JSON.stringify(card.gateIndicators)}, ${card.crisisResourcesShown},
       ${expiry})
    on conflict (case_id) do update set
      handle = excluded.handle,
      tier = excluded.tier,
      confidence = excluded.confidence,
      started_at = excluded.started_at,
      tier_floor_reason = excluded.tier_floor_reason,
      gate_indicators = excluded.gate_indicators,
      crisis_resources_shown = excluded.crisis_resources_shown,
      retention_expires_at = excluded.retention_expires_at
    returning id`;

  // Rewrite rather than append, so a second run does not triple the transcript.
  await sql`delete from turns where conversation_id = ${row.id}`;

  for (const [ordinal, turn] of redactedTurns.entries()) {
    const [turnRow] = await sql`
      insert into turns (conversation_id, ordinal, role, text)
      values (${row.id}, ${ordinal}, ${turn.role}, ${turn.redacted})
      returning id`;

    for (const span of turn.spans) {
      await sql`
        insert into pii_map (conversation_id, turn_id, entity_type, placeholder, ciphertext)
        values (${row.id}, ${turnRow.id}, ${span.type}, ${span.placeholder},
                ${seal(span.text)})`;
      spansSealed += 1;
    }
  }
}

const pct = ((turnsRedacted / turnsWritten) * 100).toFixed(1);

console.log(`${write ? "seeded" : "would seed"} ${casesSeeded} conversations`);
console.log(`  turns:          ${turnsWritten}`);
console.log(`  turns redacted: ${turnsRedacted} (${pct}%)`);
// Counted separately: a dry run finds spans but seals none, and reporting "0 sealed"
// against 16 found would read as a redaction failure rather than as the dry run working.
console.log(`  spans found:    ${spansFound}`);
console.log(`  spans sealed:   ${write ? spansSealed : "0 (dry run)"}`);
for (const [type, count] of [...bySpanType].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${type.padEnd(10)} ${count}`);
}

if (turnsRedacted === 0) {
  console.error(
    "\nNothing was redacted. That is the day 8 failure recurring — check that\n" +
      "fixtures/entities.json has debug_plaintext populated.",
  );
  process.exit(1);
}

if (!write) console.log("\ndry run. Re-run with --write to apply.");
process.exit(0);
