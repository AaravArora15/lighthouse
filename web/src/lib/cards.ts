/**
 * Escalation cards, read from the committed fixture.
 *
 * `fixtures/escalation_cards.json` is produced by `python -m lighthouse.model.card --write`
 * and holds all 80 conversations already scored: tier, calibrated confidence, gate
 * indicators, verbatim quotes, timeline.
 *
 * **Precomputed on purpose, not as a shortcut.** `docs/context.md` §9 names the
 * two-runtime risk and its mitigation: the demo ships with classifier scores already
 * computed so it never depends on a free HF Space being awake. Free Spaces sleep after 48h
 * and take ~30s to cold-start, which is exactly the wrong thing to discover while a judge
 * is watching. The live path (day 9) calls the Space with a timeout and degrades to
 * gate-only triage; this path is what the counsellor console reads.
 *
 * The consequence to keep in mind: **regenerate the fixture after any change to the gate,
 * the features, or the head.** `ml/tests/test_cards.py` fails when it is stale.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QUEUED_TIERS, Tier, tierRank } from "@/lib/taxonomy";

export interface CitedQuote {
  turnId: string;
  /** Verbatim. Never paraphrased, never cleaned up. */
  text: string;
  score: number;
  /** `self_harm_intent / first_person_cutting`, or an honest "no explicit signal" label. */
  reason: string;
}

export interface TimelinePoint {
  turnId: string;
  ordinal: number;
  risk: number;
}

export interface EscalationCard {
  caseId: string;
  handle: string;
  tier: Tier;
  confidence: number;
  /** Set only when the gate CHANGED the tier. Null when the model already agreed. */
  tierFloorReason: string | null;
  /**
   * The gate's floor, independent of whether it moved the tier.
   *
   * Use THIS to decide what an override may not go below. `tierFloorReason` is null
   * whenever the model already matched the floor, so inferring a floor from it lets a
   * counsellor downgrade exactly the cases where the floor matters most.
   */
  gateFloor: Tier | null;
  gateIndicators: string[];
  citedQuotes: CitedQuote[];
  entities: { people: string[]; places: string[]; platforms: string[] };
  sessionTimeline: TimelinePoint[];
  deltaSinceLastSession: string | null;
  patternClusterId: string | null;
  retentionExpiresAt: string | null;
  reasons: string[];
  queueRank: number;
  escalation: number;
  /** Pre-gate. Differs from `tier` exactly when the gate moved the case. */
  modelTier: Tier;
  slaHours: number | null;
  action: string;
  crisisResourcesShown: boolean;
  nStudentTurns: number;
}

const FIXTURE = join(
  process.cwd(),
  "..",
  "fixtures",
  "escalation_cards.json",
);

let cache: EscalationCard[] | null = null;

export function allCards(): EscalationCard[] {
  cache ??= JSON.parse(readFileSync(FIXTURE, "utf8")) as EscalationCard[];
  return cache;
}

/**
 * The queue, in the order a counsellor works it.
 *
 * Sorted by `queueRank`, which is `floor_rank + escalation` — the gate floor is the
 * primary sort and the model is the tie-break. Day 4 measured that ranking by the model
 * score alone understated recall@20 by 0.15, because it scored a component rather than
 * the product. Do not "simplify" this to sort by confidence.
 *
 * T0 and T1 are excluded: they are logged, not queued (`QUEUED_TIERS`). Showing a
 * counsellor 28 cases that need no action is how a queue stops being read.
 */
export function queue(): EscalationCard[] {
  return allCards()
    .filter((c) => QUEUED_TIERS.has(c.tier))
    .sort((a, b) => b.queueRank - a.queueRank || tierRank(b.tier) - tierRank(a.tier));
}

export function cardById(caseId: string): EscalationCard | undefined {
  return allCards().find((c) => c.caseId === caseId);
}

/** Counts for the queue header, including the logged-only tiers the queue hides. */
export function queueStats() {
  const cards = allCards();
  const byTier = Object.fromEntries(
    Object.values(Tier).map((t) => [t, cards.filter((c) => c.tier === t).length]),
  ) as Record<Tier, number>;
  return {
    total: cards.length,
    queued: cards.filter((c) => QUEUED_TIERS.has(c.tier)).length,
    breakGlass: byTier[Tier.T4],
    byTier,
  };
}
