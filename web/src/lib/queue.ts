/**
 * The counsellor queue: seeded cases and live ones, in one list.
 *
 * Kept separate from `cards.ts` on purpose. `cards.ts` is the compiled-in fixture and
 * knows nothing about storage; the merge lives here so the dependency runs one way
 * (`queue -> cards`, `queue -> store`) and there is no cycle between the fixture and the
 * database layer.
 *
 * ## Live cases are not pinned to the top
 *
 * The tempting thing is to show the conversation that just happened first. That would be
 * a recency bias dressed up as urgency, and this queue exists precisely to stop a
 * counsellor working by recency. A live T2 sorts below a seeded T4, because it *is* below
 * it. The ordering is `queueRank` — the gate floor first, the model as tie-break — exactly
 * as `cards.ts:queue` documents, and a live case is ranked on the same scale as any other.
 *
 * What live cases do get is a visible marker, because "scored by the gate only" is
 * information a counsellor needs in order to read the tier correctly.
 */

import { allCards, queue as seededQueue, type EscalationCard } from "@/lib/cards";
import { QUEUED_TIERS, Tier, tierRank } from "@/lib/taxonomy";
import { store } from "@/lib/store";

/** Every case a counsellor could look at, seeded and live. */
export async function allCases(): Promise<EscalationCard[]> {
  const live = await (await store()).liveCards();
  return [...live, ...allCards()];
}

/**
 * The queue, in the order a counsellor works it.
 *
 * T0 and T1 are excluded exactly as in the seeded path: they are logged, not queued.
 * A live conversation that never trips the gate therefore does not appear here, which is
 * correct — most conversations should not.
 */
export async function queue(): Promise<EscalationCard[]> {
  const live = await (await store()).liveCards();
  const merged = [...live.filter((c) => QUEUED_TIERS.has(c.tier)), ...seededQueue()];
  return merged.sort(
    (a, b) => b.queueRank - a.queueRank || tierRank(b.tier) - tierRank(a.tier),
  );
}

/** A case by id, live or seeded. Live wins, since a live id can never collide with `syn-`. */
export async function caseById(caseId: string): Promise<EscalationCard | undefined> {
  const fromStore = await (await store()).liveCard(caseId);
  if (fromStore) return fromStore;
  return allCards().find((c) => c.caseId === caseId);
}

export interface QueueStats {
  total: number;
  queued: number;
  breakGlass: number;
  live: number;
  awaitingClassifier: number;
  byTier: Record<Tier, number>;
}

export async function queueStats(): Promise<QueueStats> {
  const cases = await allCases();
  const byTier = Object.fromEntries(
    Object.values(Tier).map((t) => [t, cases.filter((c) => c.tier === t).length]),
  ) as Record<Tier, number>;

  return {
    total: cases.length,
    queued: cases.filter((c) => QUEUED_TIERS.has(c.tier)).length,
    breakGlass: byTier[Tier.T4],
    live: cases.filter((c) => c.awaitingClassifier !== undefined).length,
    awaitingClassifier: cases.filter((c) => c.awaitingClassifier === true).length,
    byTier,
  };
}
