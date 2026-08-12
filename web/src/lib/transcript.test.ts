/**
 * The transcript, and the ordering rule it enforces.
 *
 * `docs/context.md` §17: a counsellor may read a case without deciding anything, and may
 * not decide without reading. These tests are that sentence in both directions, because
 * the failure mode being guarded against is not a crash — it is a counsellor forming a
 * judgement from evidence selected to agree with the tier they are judging, which produces
 * a plausible override with nothing behind it.
 *
 * Offline by construction: the in-memory store, pure policy functions, no key, no network.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { recordAccess } from "@/lib/audit";
import type { Principal } from "@/lib/auth/session";
import { breakGlass } from "@/lib/breakglass";
import { allCards } from "@/lib/cards";
import { recordOverride } from "@/lib/overrides";
import { createMemoryStore, type Store } from "@/lib/store";
import { Tier } from "@/lib/taxonomy";
import {
  TranscriptError,
  hasReadTranscript,
  openTranscript,
  transcriptWasRead,
} from "@/lib/transcript";

const ALEX: Principal = {
  counsellorId: "00000000-0000-4000-8000-00000000000a",
  email: "alex@school.example",
  displayName: "Alex",
  role: "counsellor",
};

const SAM: Principal = {
  counsellorId: "00000000-0000-4000-8000-00000000000b",
  email: "sam@school.example",
  displayName: "Sam",
  role: "lead",
};

const CASE = "live-test01";
const REASON = "Checking whether the flagged line means what the gate thinks it means";

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
});

/**
 * Put a conversation in the store so there is something to open.
 *
 * The turns are the day-3 adversarial shape on purpose: a T4-looking first line whose
 * meaning is only settled by the third one. That is the case this whole ordering rule
 * exists for, and it is unreadable from a card that quotes the highest-scoring turn.
 */
async function seedTurns(caseId = CASE) {
  const card = allCards()[0];
  await store.upsertLiveConversation({
    caseId,
    handle: "lanternfish",
    startedAt: new Date("2026-08-01T09:00:00Z").toISOString(),
    tier: Tier.T4,
    confidence: null,
    tierFloorReason: null,
    gateLevel: "high",
    gateIndicators: ["self_harm_intent"],
    crisisResourcesShown: true,
    retentionExpiresAt: null,
    card: { ...card, caseId },
    turns: [
      { ordinal: 0, role: "student", text: "we read a book where a girl was cutting", spans: [] },
      { ordinal: 1, role: "assistant", text: "that sounds like a heavy thing to read", spans: [] },
      { ordinal: 2, role: "student", text: "yeah it was for english lit", spans: [] },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// Opening it
// ---------------------------------------------------------------------------------------

describe("opening the transcript", () => {
  it("refuses without a reason, and writes no audit row", async () => {
    await seedTurns();

    await expect(
      openTranscript(store, { caseId: CASE, principal: ALEX, tier: Tier.T4, reason: "" }),
    ).rejects.toBeInstanceOf(TranscriptError);

    expect(await store.accessForCase(CASE)).toHaveLength(0);
  });

  it("returns every turn, both roles, and records exactly one read", async () => {
    await seedTurns();

    const turns = await openTranscript(store, {
      caseId: CASE,
      principal: ALEX,
      tier: Tier.T4,
      reason: REASON,
    });

    // Both sides. A counsellor judging "did the student mean this" needs what was asked.
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.role)).toEqual(["student", "assistant", "student"]);

    const log = await store.accessForCase(CASE);
    const reads = log.filter((r) => r.action === "viewed_transcript");
    expect(reads).toHaveLength(1);
    expect(reads[0].counsellorEmail).toBe("alex@school.example");
    // The student reads this sentence on their own page.
    expect(reads[0].reason).toBe(REASON);
  });

  it("still records the read when the conversation content has been erased", async () => {
    // No seeded turns: what a retention-deleted case looks like. The access happened.
    await openTranscript(store, {
      caseId: "gone-1",
      principal: ALEX,
      tier: Tier.T2,
      reason: REASON,
    });

    const log = await store.accessForCase("gone-1");
    expect(log.filter((r) => r.action === "viewed_transcript")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// The ordering rule
// ---------------------------------------------------------------------------------------

describe("a counsellor cannot decide without reading", () => {
  it("refuses an override before the transcript, and says what to do", async () => {
    await seedTurns();

    await expect(
      recordOverride(store, {
        caseId: CASE,
        principal: ALEX,
        predictedTier: Tier.T4,
        requestedTier: Tier.T2,
        reason: "looks like they were describing a book, not themselves",
        gateFloor: Tier.T4,
      }),
    ).rejects.toThrow(/Open the full conversation/);

    // Nothing was written. A refused decision must not leave a half-record.
    expect(await store.overrideForCase(CASE)).toBeNull();
  });

  it("refuses a break-glass before the transcript", async () => {
    await seedTurns();

    await expect(
      breakGlass(store, {
        caseId: CASE,
        principal: ALEX,
        gateFloor: Tier.T4,
        closedAtTier: Tier.T1,
        reason: "student was describing a novel they read in english lit, not themselves",
      }),
    ).rejects.toThrow(/Open the full conversation/);

    expect(await store.breakGlassForCase(CASE)).toHaveLength(0);
  });

  it("allows both once the transcript has been opened", async () => {
    await seedTurns();
    await openTranscript(store, {
      caseId: CASE,
      principal: ALEX,
      tier: Tier.T4,
      reason: REASON,
    });

    const override = await recordOverride(store, {
      caseId: CASE,
      principal: ALEX,
      predictedTier: Tier.T4,
      requestedTier: Tier.T2,
      reason: "they were describing a book, confirmed in the conversation",
      gateFloor: Tier.T4,
    });
    // The floor still holds. Reading buys the right to an opinion, not to lower a floor.
    expect(override.effectiveTier).toBe(Tier.T4);

    const glass = await breakGlass(store, {
      caseId: CASE,
      principal: ALEX,
      gateFloor: Tier.T4,
      closedAtTier: Tier.T1,
      reason: "student was describing a novel they read in english lit, not themselves",
    });
    expect(glass.closedAtTier).toBe(Tier.T1);
  });

  it("is per counsellor: a colleague's read does not qualify anyone else", async () => {
    await seedTurns();
    await openTranscript(store, {
      caseId: CASE,
      principal: SAM,
      tier: Tier.T4,
      reason: REASON,
    });

    expect(await hasReadTranscript(store, CASE, SAM.counsellorId)).toBe(true);
    expect(await hasReadTranscript(store, CASE, ALEX.counsellorId)).toBe(false);

    await expect(
      recordOverride(store, {
        caseId: CASE,
        principal: ALEX,
        predictedTier: Tier.T4,
        requestedTier: Tier.T2,
        reason: "sam told me it was about a book",
        gateFloor: Tier.T4,
      }),
    ).rejects.toThrow(/Open the full conversation/);
  });

  it("does not accept a card view as having read the conversation", async () => {
    await seedTurns();
    // Opening the case writes `viewed_card`. That is the artifact the rule exists because
    // of, so it must not satisfy the rule.
    await recordAccess(store, { caseId: CASE, principal: ALEX, action: "viewed_card" });

    expect(await hasReadTranscript(store, CASE, ALEX.counsellorId)).toBe(false);
  });
});

describe("transcriptWasRead", () => {
  it("is false on an empty log", () => {
    expect(transcriptWasRead([], ALEX.counsellorId)).toBe(false);
  });
});
