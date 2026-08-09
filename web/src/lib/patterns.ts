/**
 * Cross-conversation pattern alerts, read from the committed fixture.
 *
 * Produced by `python -m lighthouse.cluster.patterns --write`. Entity values are keyed
 * HMAC pseudonyms — the console can say "three reports name the same person" and neither
 * it nor the database ever holds that person's name.
 *
 * An alert is **a prompt to look, not a finding**. It never changes a tier and never
 * merges cases; a counsellor decides what it means.
 */


import fixture from "@/fixtures/pattern_alerts.json";
import type { Tier } from "@/lib/taxonomy";

export interface PatternLink {
  a: string;
  b: string;
  entityOverlap: number;
  lexical: number;
  daysApart: number;
  sharedPeople: string[];
  sharedPlaces: string[];
  /** Counsellor-readable: "1 shared person and 1 shared location, 3 days apart". */
  reason: string;
}

export interface PatternAlert {
  clusterId: string;
  caseIds: string[];
  size: number;
  windowDays: number;
  sharedPeople: string[];
  sharedPlaces: string[];
  headline: string;
  links: PatternLink[];
  tiers: Tier[];
}

/**
 * Imported rather than read off disk. This was a `readFileSync` of `../fixtures` until
 * day 9 — see the note in `cards.ts` for why that breaks on serverless.
 *
 * The old version wrapped the read in a try/catch that fell back to an empty list, on the
 * principle that a missing pattern layer must not take the queue down with it. Correct
 * instinct, wrong consequence here: on Vercel the file was always going to be missing, so
 * the catch would have swallowed it and the pattern alerts — the novel part of this
 * project — would have quietly not existed in the deployed demo, with nothing in the logs.
 * A static import cannot fail at request time at all, so there is nothing left to catch.
 */
const ALERTS = (fixture as { alerts: PatternAlert[] }).alerts;

export function allAlerts(): PatternAlert[] {
  return ALERTS;
}

export function alertsForCase(caseId: string): PatternAlert[] {
  return allAlerts().filter((a) => a.caseIds.includes(caseId));
}
