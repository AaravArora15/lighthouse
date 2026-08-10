/**
 * Turning a live chat into a case.
 *
 * Until now the two halves of this product did not touch. The chat ran the gate, streamed
 * a reply, and threw the conversation away; the console read eighty precomputed synthetic
 * cards. You could demo either half and not the arc between them, which is the actual
 * pitch. This module is that seam.
 *
 * ## The card is written from the gate alone, and that is a designed state
 *
 * `docs/context.md` §9 already commits to it: the live path calls the classifier with a
 * timeout and **degrades to gate-only triage**, saying so in the UI. So a case exists the
 * moment a student sends their first message, carrying the gate's floor as its tier and
 * `awaitingClassifier: true`. When the scoring service answers, the richer card replaces
 * this one in place.
 *
 * That ordering is not a compromise, it is the safety property. The gate is 123 µs of
 * regex with no network; the classifier is an HTTP call to something that may be asleep.
 * **A case that only exists once a model responds is a case that does not exist during an
 * outage**, and the conversations that most need to survive an outage are exactly the ones
 * the gate floors at T4.
 *
 * ## Redaction happens here, on the way in
 *
 * Nothing raw is ever written. Each turn is redacted and its identifying spans sealed
 * before it reaches the database, using the same pipeline the seed script runs. The
 * verbatim quotes on the card are sliced from the *redacted* text, which is why the gate's
 * normalisation is length-preserving — offsets have to survive the whole journey.
 */

import { randomBytes } from "node:crypto";

import type { CitedQuote, EscalationCard, TimelinePoint } from "@/lib/cards";
import * as config from "@/lib/config";
import { hitWeight, type SafetyVerdict } from "@/lib/gate/safety";
import { redact } from "@/lib/privacy/redact";
import { hasKey, seal } from "@/lib/privacy/seal";
import { retentionExpiry } from "@/lib/retention";
import type { LiveTurn, Store } from "@/lib/store";
import { TIERS, Tier, applyFloor, tierRank } from "@/lib/taxonomy";

/** Live cases are prefixed so they are distinguishable from the seeded `syn-` corpus. */
export const LIVE_PREFIX = "live-";

export function isLiveCase(caseId: string): boolean {
  return caseId.startsWith(LIVE_PREFIX);
}

/**
 * A case id, and therefore a capability.
 *
 * The student is anonymous, so there is no account to authenticate a receipt page against.
 * **The URL is the credential**, which is the right model here (there is nothing else to
 * check) but makes the id's width a security property rather than a cosmetic one.
 *
 * The first version was `randomUUID().slice(0, 8)`: 32 bits, about 4 billion, enumerable
 * by anyone willing to spend a weekend on it. 128 bits of CSPRNG output is not.
 *
 * Older 8-character ids created before this change still resolve. `isLiveCase` keys off
 * the prefix, not the length, so nothing breaks; they are simply weaker, and there are
 * only a handful, all from testing.
 */
export function newCaseId(): string {
  return LIVE_PREFIX + randomBytes(16).toString("base64url");
}

/**
 * A pronounceable pseudonym, in the style of the seeded corpus (`quietbird`,
 * `lanternfish`). Not unique, deliberately: forcing uniqueness would leak the existence of
 * the other student who picked the same one.
 */
const ADJECTIVES = [
  "quiet", "lantern", "amber", "hollow", "still", "grey", "bright", "north",
  "small", "winter", "paper", "river", "copper", "even", "slow",
];
const NOUNS = [
  "bird", "fish", "fox", "moth", "pine", "wren", "stone", "kite",
  "hare", "reed", "lark", "elm", "finch", "owl", "vale",
];

export function newHandle(): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  return pick(ADJECTIVES) + pick(NOUNS);
}

/**
 * Reasons a counsellor reads, from a closed bank.
 *
 * Mirrors `_GATE_REASONS` in `ml/lighthouse/model/card.py`. Same rule as everywhere else
 * in this project: **no sentence on a card is improvised.** A counsellor deciding whether
 * to break a child's anonymity should read a line a human committed to in advance, not one
 * a model produced on the spot.
 */
const GATE_REASONS: Partial<Record<string, string>> = {
  self_harm_intent: "Stated intent to self-harm or end their life.",
  self_harm_past: "Described self-harm that has already happened.",
  abuse_disclosure: "Described harm being done to them by someone else.",
  weapon_or_violence: "Mentioned a weapon or planned violence.",
  imminence: "Language suggesting something is about to happen.",
  isolation: "Described having nobody to turn to.",
};

/** What a case at each tier needs from a counsellor. Mirrors `_TIER_REASONS`. */
const TIER_REASONS: Record<Tier, string> = {
  [Tier.T0]: "No action needed; logged only.",
  [Tier.T1]: "Mild concern; logged, no action needed.",
  [Tier.T2]: "Sustained difficulty. Queue for a conversation.",
  [Tier.T3]: "Significant distress. Contact within 24 hours.",
  [Tier.T4]: "Risk to life. Act now.",
};

export interface BuildCardInput {
  caseId: string;
  handle: string;
  startedAt: string;
  /** Redacted student turns, in order. */
  studentTurns: string[];
  verdict: SafetyVerdict;
  crisisResourcesShown: boolean;
}

/**
 * Build a card from the safety gate alone.
 *
 * The tier is `applyFloor(T0, gateFloor)` — the gate's floor, or T0 if it did not fire.
 * Not a guess dressed up as a prediction: `awaitingClassifier` says exactly what this is,
 * the confidence is null rather than a fabricated number, and the console renders it as
 * provisional. Inventing a confidence for a card no model has seen would be the single
 * most dishonest thing this product could do.
 */
export function buildGateCard(input: BuildCardInput): EscalationCard {
  const floor = input.verdict.floor;
  const tier = applyFloor(Tier.T0, floor);

  const categories = [...new Set(input.verdict.indicators.map((h) => h.category))];

  const reasons: string[] = [TIER_REASONS[tier]];
  for (const category of categories) {
    const reason = GATE_REASONS[category];
    // A category with no template is reported as itself rather than dropped. `MISSES` in
    // card.py exists for the same reason: a gap in the bank should be visible, not silent.
    reasons.push(reason ?? `Safety gate flagged: ${category}.`);
  }
  reasons.push("Scored by the safety gate only. The classifier has not run on this yet.");

  // Quote the turns the gate actually fired on, in order, capped. Every quote is a span
  // the student wrote; nothing here is paraphrased.
  const quotes: CitedQuote[] = [];
  const seen = new Set<number>();
  for (const hit of input.verdict.indicators) {
    if (quotes.length >= config.MAX_CITED_QUOTES) break;
    const index = hit.turnIndex;
    if (seen.has(index)) continue;
    const text = input.studentTurns[index];
    if (!text) continue;
    seen.add(index);
    quotes.push({
      turnId: `turn-${index}`,
      text,
      score: hitWeight(hit),
      reason: `${hit.category} / ${hit.pattern}`,
    });
  }

  // Nothing fired, but the case still needs evidence a counsellor can read. Falling back
  // to the most recent turn, labelled honestly — the same `require_evidence` behaviour
  // day 6 settled on after shipping T3 cards with no quotes at all.
  if (quotes.length === 0 && input.studentTurns.length > 0) {
    const index = input.studentTurns.length - 1;
    quotes.push({
      turnId: `turn-${index}`,
      text: input.studentTurns[index],
      score: 0,
      reason: "no explicit signal; most recent message",
    });
  }

  const timeline: TimelinePoint[] = input.studentTurns.map((_, i) => ({
    turnId: `turn-${i}`,
    ordinal: i,
    // The per-turn gate level, coarsely mapped. Not a model risk score and not labelled
    // as one; the sparkline shows the shape of the conversation, not a probability.
    risk: input.verdict.indicators.some((h) => h.turnIndex === i) ? 1 : 0,
  }));

  const spec = TIERS[tier];

  return {
    caseId: input.caseId,
    handle: input.handle,
    tier,
    // Null, not a number. See the doc comment on `confidence`: no model has scored this.
    confidence: null,
    tierFloorReason:
      floor !== null
        ? `The safety gate floors this conversation at ${floor}.`
        : null,
    gateFloor: floor,
    gateIndicators: categories,
    citedQuotes: quotes,
    entities: { people: [], places: [], platforms: [] },
    sessionTimeline: timeline,
    deltaSinceLastSession: null,
    patternClusterId: null,
    retentionExpiresAt: retentionExpiry(input.startedAt, tier),
    reasons,
    /**
     * `floor_rank + escalation`, matching `predict.py:queue_rank` — the floor is the
     * primary sort and the model is the tie-break.
     *
     * The model half is **unknown** here, not zero, and the difference is the whole
     * point. The first version used `tierRank(tier)`, which is `floor_rank + 0`, and a
     * live T4 landed 17th in the queue below sixteen seeded T4s: a student in crisis
     * right now, sorted underneath demo data, because "not scored yet" was being read as
     * "scored low".
     *
     * So an unscored case resolves to the **top of its floor band**. The asymmetry is
     * plain: a case nothing has assessed, which the gate has already floored, carries the
     * most unresolved uncertainty and the least elapsed handling. Treating unknown as
     * zero systematically demotes exactly the cases we know least about.
     */
    queueRank: (floor !== null ? tierRank(floor) : 0) + 1.0,
    escalation: 0,
    modelTier: Tier.T0,
    slaHours: spec.slaHours,
    action: spec.action,
    crisisResourcesShown: input.crisisResourcesShown,
    nStudentTurns: input.studentTurns.length,
    awaitingClassifier: true,
  };
}

/**
 * Replace a stored gate-only card with one the scoring service produced.
 *
 * Only the card and the tier-shaped columns move. The transcript is untouched: it was
 * already redacted and sealed on the way in, and re-writing it would mean re-encrypting
 * spans that are already encrypted, for no gain and one more chance to lose them.
 */
export async function saveScoredCard(
  store: Store,
  input: {
    caseId: string;
    handle: string;
    startedAt: string;
    card: EscalationCard;
    verdict: SafetyVerdict;
    crisisResourcesShown: boolean;
  },
): Promise<void> {
  await store.upsertScoredCard({
    caseId: input.caseId,
    tier: input.card.tier,
    confidence: input.card.confidence,
    tierFloorReason: input.card.tierFloorReason,
    retentionExpiresAt: input.card.retentionExpiresAt,
    card: input.card,
  });
}

export interface PersistInput {
  caseId: string;
  handle: string;
  startedAt: string;
  /** RAW turns, in order. Redaction happens inside this function, never before it. */
  turns: { role: "student" | "assistant"; text: string }[];
  verdict: SafetyVerdict;
  crisisResourcesShown: boolean;
}

/**
 * Redact, seal, and write the whole conversation plus its card.
 *
 * Returns the card so the caller can hand it straight back to the client. Throws if the
 * PII key is missing: writing transcripts with their identifying spans in the clear is the
 * one failure this schema exists to prevent, and a silent fallback to storing raw text
 * would look identical to working.
 */
export async function persistConversation(
  store: Store,
  input: PersistInput,
): Promise<EscalationCard> {
  if (!hasKey()) {
    throw new Error(
      "LIGHTHOUSE_PII_KEY is not set. Refusing to store a transcript with its " +
        "identifying spans in the clear.",
    );
  }

  const stored: LiveTurn[] = input.turns.map((turn, ordinal) => {
    // No `known` entities: the day 7 extractor is an offline batch step over a finished
    // conversation and there is nothing to call here. So live redaction is regex-only,
    // which catches phones, emails, URLs and addresses and **misses lowercase names**.
    // That is the day 8 limitation, unchanged and stated rather than hidden.
    const { redacted, spans } = redact(turn.text);
    return {
      ordinal,
      role: turn.role,
      text: redacted,
      spans: spans.map((span) => ({
        entityType: span.type,
        placeholder: span.placeholder,
        ciphertext: seal(span.text),
      })),
    };
  });

  // The card quotes REDACTED text, because that is what a counsellor is shown.
  const card = buildGateCard({
    caseId: input.caseId,
    handle: input.handle,
    startedAt: input.startedAt,
    studentTurns: stored.filter((t) => t.role === "student").map((t) => t.text),
    verdict: input.verdict,
    crisisResourcesShown: input.crisisResourcesShown,
  });

  await store.upsertLiveConversation({
    caseId: input.caseId,
    handle: input.handle,
    startedAt: input.startedAt,
    tier: card.tier,
    confidence: null,
    tierFloorReason: card.tierFloorReason,
    gateLevel: input.verdict.level as "clear" | "grey" | "high",
    gateIndicators: card.gateIndicators,
    crisisResourcesShown: input.crisisResourcesShown,
    retentionExpiresAt: card.retentionExpiresAt,
    card,
    turns: stored,
  });

  return card;
}
