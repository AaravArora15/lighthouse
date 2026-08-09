/**
 * The access log: what it refuses to write, and what it refuses to forget.
 *
 * `docs/context.md` §11 promises a student can see who opened their case. These tests are
 * that promise stated as behaviour — including the plain-language rendering, because a log
 * only a DBA can read is not one a fifteen-year-old can hold anyone to.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { AuditError, REASON_REQUIRED, describeAccess, recordAccess } from "@/lib/audit";
import type { Principal } from "@/lib/auth/session";
import { createMemoryStore, type AuditAction, type Store } from "@/lib/store";

const COUNSELLOR: Principal = {
  counsellorId: "00000000-0000-4000-8000-00000000000a",
  email: "c@school.example",
  displayName: "C Counsellor",
  role: "counsellor",
};

const ALL_ACTIONS: AuditAction[] = [
  "viewed_card",
  "viewed_transcript",
  "unsealed_pii",
  "overrode_tier",
  "broke_glass",
  "reviewed_break_glass",
];

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
});

describe("writing", () => {
  it("records who, what and when", async () => {
    const entry = await recordAccess(store, {
      caseId: "syn-001",
      principal: COUNSELLOR,
      action: "viewed_card",
    });
    expect(entry.counsellorId).toBe(COUNSELLOR.counsellorId);
    expect(entry.counsellorEmail).toBe(COUNSELLOR.email);
    expect(entry.action).toBe("viewed_card");
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it("copies the actor's email into the row rather than referencing it", async () => {
    // An audit row has to stay readable after the account it names is deleted, so it
    // cannot depend on a join to a mutable table for its meaning.
    await recordAccess(store, {
      caseId: "syn-001",
      principal: COUNSELLOR,
      action: "viewed_card",
    });
    const [row] = await store.accessForCase("syn-001");
    expect(row.counsellorEmail).toBe("c@school.example");
  });

  it("keeps every access, not just the latest", async () => {
    for (let i = 0; i < 5; i++) {
      await recordAccess(store, {
        caseId: "syn-001",
        principal: COUNSELLOR,
        action: "viewed_card",
      });
    }
    expect(await store.accessForCase("syn-001")).toHaveLength(5);
  });

  it("returns same-millisecond rows in the order they were written", async () => {
    // The bug this is here for: with only `at` and a random-UUID tie-break, two actions in
    // the same tick came back in arbitrary order. Opening a case and acting on it happen
    // in the same millisecond constantly, and a student reading "who opened my case" has
    // to see what actually happened first.
    const at = new Date("2026-08-09T12:00:00.000Z");
    await recordAccess(store, {
      caseId: "syn-001",
      principal: COUNSELLOR,
      action: "viewed_card",
      at,
    });
    await recordAccess(store, {
      caseId: "syn-001",
      principal: COUNSELLOR,
      action: "overrode_tier",
      reason: "escalating after speaking to their form tutor",
      at,
    });

    const log = await store.accessForCase("syn-001");
    expect(log.map((e) => e.action)).toEqual(["viewed_card", "overrode_tier"]);
  });

  it("keeps each case's log separate", async () => {
    await recordAccess(store, { caseId: "a", principal: COUNSELLOR, action: "viewed_card" });
    await recordAccess(store, { caseId: "b", principal: COUNSELLOR, action: "viewed_card" });
    expect(await store.accessForCase("a")).toHaveLength(1);
    expect(await store.accessForCase("b")).toHaveLength(1);
  });
});

describe("reasons", () => {
  it("lets a plain card view through without one", async () => {
    await expect(
      recordAccess(store, { caseId: "syn-001", principal: COUNSELLOR, action: "viewed_card" }),
    ).resolves.toBeTruthy();
  });

  it.each(Object.keys(REASON_REQUIRED) as AuditAction[])(
    "refuses %s with no reason",
    async (action) => {
      await expect(
        recordAccess(store, { caseId: "syn-001", principal: COUNSELLOR, action }),
      ).rejects.toBeInstanceOf(AuditError);
    },
  );

  it.each(Object.entries(REASON_REQUIRED) as [AuditAction, number][])(
    "refuses %s with a reason one character too short",
    async (action, required) => {
      await expect(
        recordAccess(store, {
          caseId: "syn-001",
          principal: COUNSELLOR,
          action,
          reason: "x".repeat(required - 1),
        }),
      ).rejects.toBeInstanceOf(AuditError);
    },
  );

  it.each(Object.entries(REASON_REQUIRED) as [AuditAction, number][])(
    "accepts %s at exactly the threshold",
    async (action, required) => {
      await expect(
        recordAccess(store, {
          caseId: "syn-001",
          principal: COUNSELLOR,
          action,
          reason: "x".repeat(required),
        }),
      ).resolves.toBeTruthy();
    },
  );

  it("does not accept whitespace padding as a reason", async () => {
    await expect(
      recordAccess(store, {
        caseId: "syn-001",
        principal: COUNSELLOR,
        action: "unsealed_pii",
        reason: "  ".repeat(40),
      }),
    ).rejects.toBeInstanceOf(AuditError);
  });

  it("writes no row when it refuses", async () => {
    await expect(
      recordAccess(store, {
        caseId: "syn-001",
        principal: COUNSELLOR,
        action: "unsealed_pii",
        reason: "because",
      }),
    ).rejects.toThrow();
    expect(await store.accessForCase("syn-001")).toHaveLength(0);
  });

  it("demands more for unsealing an identity than for reading a transcript", async () => {
    expect(REASON_REQUIRED.unsealed_pii!).toBeGreaterThan(REASON_REQUIRED.viewed_transcript!);
  });

  it("demands most for overruling the safety gate", async () => {
    const others = ALL_ACTIONS.filter((a) => a !== "broke_glass").map(
      (a) => REASON_REQUIRED[a] ?? 0,
    );
    expect(REASON_REQUIRED.broke_glass!).toBeGreaterThan(Math.max(...others));
  });
});

describe("what the student reads", () => {
  it.each(ALL_ACTIONS)("renders %s as a sentence with no jargon", (action) => {
    const text = describeAccess({
      id: "1",
      seq: 1,
      caseId: "syn-001",
      counsellorId: COUNSELLOR.counsellorId,
      counsellorEmail: COUNSELLOR.email,
      action,
      reason: null,
      at: new Date().toISOString(),
    });
    expect(text.length).toBeGreaterThan(10);
    expect(text.endsWith(".")).toBe(true);
    // No snake_case leaking through into something a teenager is meant to read.
    expect(text).not.toContain("_");
  });
});
