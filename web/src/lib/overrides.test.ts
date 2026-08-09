/**
 * Overrides, and the one rule that has no exception for humans.
 *
 * The headline test here is a regression. Day 6 shipped an override endpoint that derived
 * the gate floor from `card.tierFloorReason`, which is populated only when the gate
 * *changed* the tier. On a conversation the model already scored T4 that field is null
 * while the floor is T4 — so the check passed, and a counsellor could downgrade a
 * self-harm disclosure to T1 and have the system agree.
 *
 * It was caught by POSTing to the live endpoint rather than by any test, which is the
 * second time this project has been saved by exercising the running thing. These tests
 * exist so it is caught the cheap way next time.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { allCards } from "@/lib/cards";
import { effectiveTier, recordOverride, overrideFor } from "@/lib/overrides";
import { Tier } from "@/lib/taxonomy";

const COUNSELLOR = "test-counsellor";

describe("the gate floor survives a counsellor", () => {
  it("refuses to lower a T4 self-harm case, and says why", () => {
    const result = recordOverride({
      caseId: "syn-065",
      counsellorId: COUNSELLOR,
      predictedTier: Tier.T4,
      requestedTier: Tier.T1,
      reason: "spoke to the student, they say they are fine now",
      gateFloor: Tier.T4,
    });

    expect(result.requestedTier).toBe(Tier.T1);
    expect(result.effectiveTier).toBe(Tier.T4);
    expect(result.flooredNotice).toContain("T4");
    // The reason is kept even though the request was refused. A counsellor who believes a
    // case is over is telling us something, and it is the only ground truth we ever get.
    expect(result.reason).toContain("they say they are fine");
  });

  it.each([Tier.T0, Tier.T1, Tier.T2, Tier.T3])(
    "clamps a requested %s up to a T4 floor",
    (requested) => {
      const result = recordOverride({
        caseId: `clamp-${requested}`,
        counsellorId: COUNSELLOR,
        predictedTier: Tier.T4,
        requestedTier: requested,
        reason: "a reason long enough to pass validation",
        gateFloor: Tier.T4,
      });
      expect(result.effectiveTier).toBe(Tier.T4);
    },
  );

  it("allows an upgrade above the floor", () => {
    const result = recordOverride({
      caseId: "syn-003",
      counsellorId: COUNSELLOR,
      predictedTier: Tier.T2,
      requestedTier: Tier.T4,
      reason: "I know this student and this is worse than it reads",
      gateFloor: Tier.T3,
    });
    expect(result.effectiveTier).toBe(Tier.T4);
    expect(result.flooredNotice).toBeNull();
  });

  it("allows any change when the gate never fired", () => {
    const result = recordOverride({
      caseId: "no-floor",
      counsellorId: COUNSELLOR,
      predictedTier: Tier.T2,
      requestedTier: Tier.T0,
      reason: "duplicate of an earlier conversation, already actioned",
      gateFloor: null,
    });
    expect(result.effectiveTier).toBe(Tier.T0);
    expect(result.flooredNotice).toBeNull();
  });
});

describe("the card carries what the endpoint needs", () => {
  // The root cause of the bug: the endpoint could not see a floor that existed.
  it("gives every gate-floored case an explicit gateFloor", () => {
    const floored = allCards().filter((c) => c.gateFloor !== null);
    expect(floored.length).toBeGreaterThan(0);
    for (const card of floored) {
      expect(Object.values(Tier)).toContain(card.gateFloor);
    }
  });

  it("records a floor on T4 cases even where tierFloorReason is null", () => {
    // This exact combination is what defeated the first implementation.
    const silentlyFloored = allCards().filter(
      (c) => c.tier === Tier.T4 && c.tierFloorReason === null,
    );
    expect(silentlyFloored.length).toBeGreaterThan(0);
    for (const card of silentlyFloored) {
      expect(card.gateFloor).toBe(Tier.T4);
    }
  });
});

describe("bookkeeping", () => {
  beforeEach(() => {
    recordOverride({
      caseId: "book-1",
      counsellorId: COUNSELLOR,
      predictedTier: Tier.T2,
      requestedTier: Tier.T3,
      reason: "escalating over the last fortnight",
      gateFloor: null,
    });
  });

  it("reports the effective tier over the card's", () => {
    expect(effectiveTier("book-1", Tier.T2)).toBe(Tier.T3);
    expect(effectiveTier("never-touched", Tier.T2)).toBe(Tier.T2);
  });

  it("keeps the model's tier alongside the override rather than replacing it", () => {
    const stored = overrideFor("book-1")!;
    expect(stored.predictedTier).toBe(Tier.T2);
    expect(stored.effectiveTier).toBe(Tier.T3);
  });
});
