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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const FIXTURE = join(process.cwd(), "..", "fixtures", "pattern_alerts.json");

let cache: PatternAlert[] | null = null;

export function allAlerts(): PatternAlert[] {
  if (cache === null) {
    try {
      cache = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { alerts: PatternAlert[] })
        .alerts;
    } catch {
      // Clustering is additive. If the fixture is absent the console still works and the
      // panel simply does not render — a missing pattern layer must never take the queue
      // down with it.
      cache = [];
    }
  }
  return cache;
}

export function alertsForCase(caseId: string): PatternAlert[] {
  return allAlerts().filter((a) => a.caseIds.includes(caseId));
}
