/**
 * Break-glass, and the review that makes it safe.
 *
 * The tests worth reading here are the ones about what break-glass *cannot* do: it cannot
 * be used where there is no floor (that is an ordinary override), it cannot close at or
 * above the floor (same), and it cannot be reviewed by the person who did it. Each of
 * those is a way the ceremony could be reduced to a formality without anyone noticing.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  BreakGlassError,
  MIN_BREAK_GLASS_REASON_CHARS,
  breakGlass,
  breakGlassForCase,
  isOpenBreakGlass,
  reviewBreakGlass,
  unreviewed,
} from "@/lib/breakglass";
import { recordAccess } from "@/lib/audit";
import type { Principal } from "@/lib/auth/session";
import { createMemoryStore, type Store } from "@/lib/store";
import { Tier } from "@/lib/taxonomy";

const COUNSELLOR: Principal = {
  counsellorId: "00000000-0000-4000-8000-00000000000a",
  email: "c@school.example",
  displayName: "C Counsellor",
  role: "counsellor",
};

const LEAD: Principal = {
  counsellorId: "00000000-0000-4000-8000-00000000000b",
  email: "lead@school.example",
  displayName: "L Lead",
  role: "lead",
};

const GOOD_REASON =
  "student was quoting song lyrics, confirmed in the transcript, no self-harm content " +
  "anywhere else in the conversation";

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
});

async function open(overrides: Partial<Parameters<typeof breakGlass>[1]> = {}) {
  const input = {
    caseId: "syn-065",
    principal: COUNSELLOR,
    gateFloor: Tier.T4,
    closedAtTier: Tier.T1,
    reason: GOOD_REASON,
    ...overrides,
  };

  // `docs/context.md` §17 refuses a break-glass until this counsellor has opened the
  // transcript. That rule is tested on its own in `transcript.test.ts`; satisfying it here
  // keeps this file about the break-glass rules rather than re-testing the ordering.
  await recordAccess(store, {
    caseId: input.caseId,
    principal: input.principal,
    action: "viewed_transcript",
    reason: "read the conversation before deciding",
  });

  return breakGlass(store, input);
}

describe("breaking glass", () => {
  it("records the floor it overruled, not just the tier it closed at", async () => {
    const record = await open();
    expect(record.gateFloor).toBe(Tier.T4);
    expect(record.closedAtTier).toBe(Tier.T1);
    expect(record.counsellorEmail).toBe(COUNSELLOR.email);
    expect(record.reviewedAt).toBeNull();
  });

  it("writes an audit row the student can read", async () => {
    await open();
    const log = await store.accessForCase("syn-065");
    const broke = log.filter((e) => e.action === "broke_glass");
    expect(broke).toHaveLength(1);
    expect(broke[0].reason).toBe(GOOD_REASON);
    // In order, and this is the sequence the student reads: someone opened the
    // conversation, then closed the case against the gate's judgement.
    expect(log.map((e) => e.action)).toEqual(["viewed_transcript", "broke_glass"]);
  });

  it("refuses where the gate never fired", async () => {
    // Not pedantry. Routing ordinary disagreement through here would fill the lead's
    // review list with cases that never needed one, and the signal would be lost.
    await expect(open({ gateFloor: null })).rejects.toBeInstanceOf(BreakGlassError);
  });

  it.each([Tier.T4, Tier.T3])(
    "refuses to close at %s when the floor is T3, because an override covers it",
    async (closedAt) => {
      await expect(
        open({ gateFloor: Tier.T3, closedAtTier: closedAt }),
      ).rejects.toBeInstanceOf(BreakGlassError);
    },
  );

  it("allows closing strictly below the floor", async () => {
    const record = await open({ gateFloor: Tier.T3, closedAtTier: Tier.T2 });
    expect(record.closedAtTier).toBe(Tier.T2);
  });

  it("refuses a reason shorter than the threshold", async () => {
    await expect(open({ reason: "false positive" })).rejects.toBeInstanceOf(BreakGlassError);
  });

  it("refuses a reason padded to length with whitespace", async () => {
    await expect(
      open({ reason: " ".repeat(MIN_BREAK_GLASS_REASON_CHARS + 10) }),
    ).rejects.toBeInstanceOf(BreakGlassError);
  });

  it("writes nothing when it refuses", async () => {
    await expect(open({ reason: "no" })).rejects.toThrow();
    expect(await breakGlassForCase(store, "syn-065")).toHaveLength(0);
    // The transcript read the helper performs is a real access and stays. What must be
    // absent is any record of the case having been closed.
    const log = await store.accessForCase("syn-065");
    expect(log.filter((e) => e.action === "broke_glass")).toHaveLength(0);
  });

  it("is available to an ordinary counsellor, not only a lead", async () => {
    // The urgent path is never gated on finding a second person. See the module doc.
    await expect(open({ principal: COUNSELLOR })).resolves.toBeTruthy();
  });
});

describe("review", () => {
  it("lands unreviewed and shows up in the queue's count", async () => {
    await open();
    expect(await unreviewed(store)).toHaveLength(1);
    expect(await isOpenBreakGlass(store, "syn-065")).toBe(true);
  });

  it("clears once a lead reviews it", async () => {
    const record = await open();
    const reviewed = await reviewBreakGlass(store, {
      id: record.id,
      principal: LEAD,
      note: "agreed, listened to the recording, it is a lyric",
    });
    expect(reviewed.reviewedBy).toBe(LEAD.counsellorId);
    expect(await unreviewed(store)).toHaveLength(0);
    expect(await isOpenBreakGlass(store, "syn-065")).toBe(false);
  });

  it("refuses a non-lead", async () => {
    const record = await open();
    await expect(
      reviewBreakGlass(store, {
        id: record.id,
        principal: { ...COUNSELLOR, counsellorId: "someone-else" },
        note: "looks fine to me honestly",
      }),
    ).rejects.toBeInstanceOf(BreakGlassError);
    expect(await unreviewed(store)).toHaveLength(1);
  });

  it("refuses a lead reviewing their own break-glass", async () => {
    // A second pair of eyes belonging to the same person is not one. A lead can break
    // glass — they work the queue too — and then someone else has to sign it off.
    const record = await open({ principal: LEAD });
    await expect(
      reviewBreakGlass(store, { id: record.id, principal: LEAD, note: "I stand by it" }),
    ).rejects.toBeInstanceOf(BreakGlassError);
    expect(await unreviewed(store)).toHaveLength(1);
  });

  it("refuses a note that says nothing", async () => {
    const record = await open();
    await expect(
      reviewBreakGlass(store, { id: record.id, principal: LEAD, note: "ok" }),
    ).rejects.toBeInstanceOf(BreakGlassError);
  });

  it("cannot be reviewed twice", async () => {
    const record = await open();
    await reviewBreakGlass(store, {
      id: record.id,
      principal: LEAD,
      note: "agreed after reading the transcript",
    });
    await expect(
      reviewBreakGlass(store, {
        id: record.id,
        principal: { ...LEAD, counsellorId: "another-lead", email: "l2@school.example" },
        note: "actually I disagree with this",
      }),
    ).rejects.toBeInstanceOf(BreakGlassError);
  });

  it("does not let a review rewrite the original account", async () => {
    const record = await open();
    const reviewed = await reviewBreakGlass(store, {
      id: record.id,
      principal: LEAD,
      note: "agreed after reading the transcript",
    });
    // Everything about what happened at the time is untouched. Only the null fields fill.
    expect(reviewed.reason).toBe(record.reason);
    expect(reviewed.gateFloor).toBe(record.gateFloor);
    expect(reviewed.closedAtTier).toBe(record.closedAtTier);
    expect(reviewed.counsellorEmail).toBe(record.counsellorEmail);
    expect(reviewed.at).toBe(record.at);
  });

  it("logs the review itself against the case", async () => {
    const record = await open();
    await reviewBreakGlass(store, {
      id: record.id,
      principal: LEAD,
      note: "agreed after reading the transcript",
    });
    const log = await store.accessForCase("syn-065");
    expect(log.map((e) => e.action)).toEqual([
      "viewed_transcript",
      "broke_glass",
      "reviewed_break_glass",
    ]);
  });

  it("refuses an unknown id", async () => {
    await expect(
      reviewBreakGlass(store, {
        id: "no-such-record",
        principal: LEAD,
        note: "reviewing something that does not exist",
      }),
    ).rejects.toBeInstanceOf(BreakGlassError);
  });
});
