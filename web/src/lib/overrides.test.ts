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

import type { Principal } from "@/lib/auth/session";
import { allCards } from "@/lib/cards";
import { OverrideError, effectiveTier, overrideFor, recordOverride } from "@/lib/overrides";
import { createMemoryStore, type Store } from "@/lib/store";
import { Tier } from "@/lib/taxonomy";

const COUNSELLOR: Principal = {
  counsellorId: "00000000-0000-4000-8000-000000000001",
  email: "test@school.example",
  displayName: "Test Counsellor",
  role: "counsellor",
};

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
});

describe("the gate floor survives a counsellor", () => {
  it("refuses to lower a T4 self-harm case, and says why", async () => {
    const result = await recordOverride(store, {
      caseId: "syn-065",
      principal: COUNSELLOR,
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

  it("points a refused downgrade at break-glass rather than leaving a dead end", async () => {
    const result = await recordOverride(store, {
      caseId: "syn-065",
      principal: COUNSELLOR,
      predictedTier: Tier.T4,
      requestedTier: Tier.T1,
      reason: "spoke to the student, they say they are fine now",
      gateFloor: Tier.T4,
    });
    expect(result.flooredNotice).toContain("break glass");
  });

  it.each([Tier.T0, Tier.T1, Tier.T2, Tier.T3])(
    "clamps a requested %s up to a T4 floor",
    async (requested) => {
      const result = await recordOverride(store, {
        caseId: `clamp-${requested}`,
        principal: COUNSELLOR,
        predictedTier: Tier.T4,
        requestedTier: requested,
        reason: "a reason long enough to pass validation",
        gateFloor: Tier.T4,
      });
      expect(result.effectiveTier).toBe(Tier.T4);
    },
  );

  it("allows an upgrade above the floor", async () => {
    const result = await recordOverride(store, {
      caseId: "syn-003",
      principal: COUNSELLOR,
      predictedTier: Tier.T2,
      requestedTier: Tier.T4,
      reason: "I know this student and this is worse than it reads",
      gateFloor: Tier.T3,
    });
    expect(result.effectiveTier).toBe(Tier.T4);
    expect(result.flooredNotice).toBeNull();
  });

  it("allows any change when the gate never fired", async () => {
    const result = await recordOverride(store, {
      caseId: "no-floor",
      principal: COUNSELLOR,
      predictedTier: Tier.T2,
      requestedTier: Tier.T0,
      reason: "duplicate of an earlier conversation, already actioned",
      gateFloor: null,
    });
    expect(result.effectiveTier).toBe(Tier.T0);
    expect(result.flooredNotice).toBeNull();
  });
});

describe("the reason is not optional", () => {
  it("refuses a short one", async () => {
    await expect(
      recordOverride(store, {
        caseId: "syn-003",
        principal: COUNSELLOR,
        predictedTier: Tier.T2,
        requestedTier: Tier.T1,
        reason: "fine",
        gateFloor: null,
      }),
    ).rejects.toBeInstanceOf(OverrideError);
  });

  it("writes nothing at all when it refuses", async () => {
    await expect(
      recordOverride(store, {
        caseId: "syn-003",
        principal: COUNSELLOR,
        predictedTier: Tier.T2,
        requestedTier: Tier.T1,
        reason: "no",
        gateFloor: null,
      }),
    ).rejects.toThrow();

    // Both halves. A rejected override that still left an audit row would tell a student
    // their case was changed when it was not.
    expect(await overrideFor(store, "syn-003")).toBeNull();
    expect(await store.accessForCase("syn-003")).toHaveLength(0);
  });

  it("does not accept whitespace as a reason", async () => {
    await expect(
      recordOverride(store, {
        caseId: "syn-003",
        principal: COUNSELLOR,
        predictedTier: Tier.T2,
        requestedTier: Tier.T1,
        reason: "              ",
        gateFloor: null,
      }),
    ).rejects.toBeInstanceOf(OverrideError);
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
  beforeEach(async () => {
    await recordOverride(store, {
      caseId: "book-1",
      principal: COUNSELLOR,
      predictedTier: Tier.T2,
      requestedTier: Tier.T3,
      reason: "escalating over the last fortnight",
      gateFloor: null,
    });
  });

  it("reports the effective tier over the card's", async () => {
    expect(effectiveTier(await overrideFor(store, "book-1"), Tier.T2)).toBe(Tier.T3);
    expect(effectiveTier(await overrideFor(store, "never-touched"), Tier.T2)).toBe(Tier.T2);
  });

  it("keeps the model's tier alongside the override rather than replacing it", async () => {
    const stored = (await overrideFor(store, "book-1"))!;
    expect(stored.predictedTier).toBe(Tier.T2);
    expect(stored.effectiveTier).toBe(Tier.T3);
  });

  it("logs the override as an access the student can read", async () => {
    const log = await store.accessForCase("book-1");
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("overrode_tier");
    expect(log[0].counsellorEmail).toBe(COUNSELLOR.email);
    expect(log[0].reason).toContain("fortnight");
  });
});
