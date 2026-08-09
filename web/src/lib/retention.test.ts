/**
 * Retention, and the two things it must never do.
 *
 * 1. **Delete a case a lead still has to review.** An unreviewed break-glass is a hold.
 *    This interaction is the one that is easy to miss, because each half is correct on its
 *    own: the sweep deletes what is due, break-glass records what was closed, and nothing
 *    in either says the second should stop the first.
 * 2. **Touch the access log.** The whole point of keying the audit tables on `case_id`
 *    with no foreign key is that this job cannot reach them. Asserted directly rather than
 *    trusted, because the previous schema *did* cascade and nobody noticed for three days.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { recordAccess } from "@/lib/audit";
import { breakGlass, reviewBreakGlass } from "@/lib/breakglass";
import type { Principal } from "@/lib/auth/session";
import * as config from "@/lib/config";
import { DAY_MS, decide, retentionExpiry, sweep } from "@/lib/retention";
import { createMemoryStore, type RetentionRecord, type Store } from "@/lib/store";
import { Tier } from "@/lib/taxonomy";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const DAYS = config.RETENTION_DAYS_NON_ESCALATED;

const COUNSELLOR: Principal = {
  counsellorId: "00000000-0000-4000-8000-00000000000a",
  email: "c@school.example",
  displayName: "C Counsellor",
  role: "counsellor",
};

const LEAD: Principal = { ...COUNSELLOR, counsellorId: "lead-id", email: "l@school.example", role: "lead" };

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
});

function record(overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  return {
    caseId: "syn-001",
    tier: Tier.T2,
    startedAt: new Date(NOW.getTime() - (DAYS + 1) * DAY_MS).toISOString(),
    retentionExpiresAt: null,
    retentionHoldReason: null,
    contentDeletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// The policy, as a pure function
// ---------------------------------------------------------------------------------------

describe("retentionExpiry", () => {
  it("is the start plus the configured window for a non-escalated case", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const expiry = retentionExpiry(start, Tier.T2)!;
    expect(Date.parse(expiry) - Date.parse(start)).toBe(DAYS * DAY_MS);
  });

  it.each([Tier.T3, Tier.T4])("is never, for an escalated %s case", (tier) => {
    expect(retentionExpiry("2026-01-01T00:00:00.000Z", tier)).toBeNull();
  });

  it.each([Tier.T0, Tier.T1, Tier.T2])("has an expiry for %s", (tier) => {
    expect(retentionExpiry("2026-01-01T00:00:00.000Z", tier)).not.toBeNull();
  });

  it("is recomputed from the current tier, so a later escalation removes the expiry", () => {
    // A case escalated after the fact must stop having an expiry rather than keeping the
    // one it was written with.
    const start = "2026-01-01T00:00:00.000Z";
    expect(retentionExpiry(start, Tier.T2)).not.toBeNull();
    expect(retentionExpiry(start, Tier.T4)).toBeNull();
  });
});

describe("decide", () => {
  it("deletes a non-escalated case past its date", () => {
    expect(decide(record(), NOW, false).delete).toBe(true);
  });

  it("does not delete one that is a day short", () => {
    const young = record({
      startedAt: new Date(NOW.getTime() - (DAYS - 1) * DAY_MS).toISOString(),
    });
    const d = decide(young, NOW, false);
    expect(d.delete).toBe(false);
    expect(d.exemption).toBeNull();
  });

  it("deletes exactly on the boundary, not a day later", () => {
    const exactly = record({
      startedAt: new Date(NOW.getTime() - DAYS * DAY_MS).toISOString(),
    });
    expect(decide(exactly, NOW, false).delete).toBe(true);
  });

  it.each([Tier.T3, Tier.T4])("exempts an escalated %s case however old", (tier) => {
    const old = record({ tier, startedAt: "2020-01-01T00:00:00.000Z" });
    const d = decide(old, NOW, false);
    expect(d.delete).toBe(false);
    expect(d.exemption).toBe("escalated");
  });

  it("exempts a case with a written hold", () => {
    const held = record({ retentionHoldReason: "open safeguarding referral" });
    expect(decide(held, NOW, false).exemption).toBe("explicit_hold");
  });

  it("exempts a case with an unreviewed break-glass", () => {
    expect(decide(record(), NOW, true).exemption).toBe("unreviewed_break_glass");
  });

  it("stops exempting once the break-glass is reviewed", () => {
    expect(decide(record(), NOW, false).delete).toBe(true);
  });

  it("skips a case whose content is already gone", () => {
    const done = record({ contentDeletedAt: NOW.toISOString() });
    expect(decide(done, NOW, false).exemption).toBe("already_deleted");
  });

  it("honours an explicitly stored expiry over the computed one", () => {
    const extended = record({
      retentionExpiresAt: new Date(NOW.getTime() + 10 * DAY_MS).toISOString(),
    });
    expect(decide(extended, NOW, false).delete).toBe(false);
  });

  it("treats an untriaged case as deletable on the ordinary schedule", () => {
    // `tier: null` means "not yet classified", which is different from T0. It must not be
    // silently exempt, or a classifier outage becomes an indefinite data-retention policy.
    expect(decide(record({ tier: null }), NOW, false).delete).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------

describe("sweep", () => {
  async function seed(...records: RetentionRecord[]) {
    for (const r of records) await store.upsertRetentionRecord(r);
  }

  it("defaults to a dry run and changes nothing", async () => {
    await seed(record());
    const result = await sweep(store, { now: NOW });
    expect(result.deleted).toEqual(["syn-001"]);

    const after = await store.retentionCandidates();
    expect(after[0].contentDeletedAt).toBeNull();
  });

  it("deletes when asked explicitly", async () => {
    await seed(record());
    await sweep(store, { now: NOW, dryRun: false });
    const after = await store.retentionCandidates();
    expect(after[0].contentDeletedAt).toBe(NOW.toISOString());
  });

  it("reports every exemption by name rather than skipping silently", async () => {
    await seed(
      record({ caseId: "old-t2" }),
      record({ caseId: "escalated", tier: Tier.T4 }),
      record({ caseId: "held", retentionHoldReason: "open referral" }),
      record({
        caseId: "young",
        startedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      }),
    );

    const result = await sweep(store, { now: NOW, dryRun: false });
    expect(result.scanned).toBe(4);
    expect(result.deleted).toEqual(["old-t2"]);
    expect(result.notYetDue).toBe(1);
    expect(result.exempt).toEqual([
      { caseId: "escalated", reason: "escalated" },
      { caseId: "held", reason: "explicit_hold" },
    ]);
  });

  it("does not delete a case whose break-glass a lead has not reviewed yet", async () => {
    await seed(record({ caseId: "syn-065" }));
    await breakGlass(store, {
      caseId: "syn-065",
      principal: COUNSELLOR,
      gateFloor: Tier.T4,
      closedAtTier: Tier.T1,
      reason: "student was quoting song lyrics, confirmed across the whole transcript",
    });

    const result = await sweep(store, { now: NOW, dryRun: false });
    expect(result.deleted).toEqual([]);
    expect(result.exempt).toEqual([
      { caseId: "syn-065", reason: "unreviewed_break_glass" },
    ]);
  });

  it("deletes it once the lead has reviewed", async () => {
    await seed(record({ caseId: "syn-065" }));
    const glass = await breakGlass(store, {
      caseId: "syn-065",
      principal: COUNSELLOR,
      gateFloor: Tier.T4,
      closedAtTier: Tier.T1,
      reason: "student was quoting song lyrics, confirmed across the whole transcript",
    });
    await reviewBreakGlass(store, {
      id: glass.id,
      principal: LEAD,
      note: "agreed, no further action",
    });

    const result = await sweep(store, { now: NOW, dryRun: false });
    expect(result.deleted).toEqual(["syn-065"]);
  });

  it("is idempotent: a second run deletes nothing more", async () => {
    await seed(record());
    const first = await sweep(store, { now: NOW, dryRun: false });
    const second = await sweep(store, { now: NOW, dryRun: false });
    expect(first.deleted).toEqual(["syn-001"]);
    expect(second.deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// The line the job cannot cross
// ---------------------------------------------------------------------------------------

describe("what retention must not erase", () => {
  it("leaves the access log intact after deleting the conversation", async () => {
    // The previous schema had `counsellor_access.conversation_id ... on delete cascade`,
    // which meant this exact sweep also deleted every record of who had opened the case.
    // An audit log a routine cleanup job can erase is not an audit log.
    await store.upsertRetentionRecord(record({ caseId: "syn-001" }));
    await recordAccess(store, {
      caseId: "syn-001",
      principal: COUNSELLOR,
      action: "viewed_card",
    });

    await sweep(store, { now: NOW, dryRun: false });

    const log = await store.accessForCase("syn-001");
    expect(log).toHaveLength(1);
    expect(log[0].counsellorEmail).toBe(COUNSELLOR.email);
  });

  it("leaves a tombstone rather than removing the case entirely", async () => {
    // "What you wrote will be gone" is the promise. "There will be no trace anything
    // happened" is not, and cannot be: a counsellor who read a case stays accountable
    // for having read it after the case is gone.
    await store.upsertRetentionRecord(record({ caseId: "syn-001" }));
    await sweep(store, { now: NOW, dryRun: false });

    const rows = await store.retentionCandidates();
    expect(rows.map((r) => r.caseId)).toEqual(["syn-001"]);
    expect(rows[0].contentDeletedAt).toBe(NOW.toISOString());
  });

  it("offers no way to delete an audit row at all", () => {
    // Not a runtime check: the operation does not exist on the interface, so the retention
    // job has nothing to call even if a future version wanted to.
    const keys = Object.keys(store);
    expect(keys.filter((k) => /^delete/i.test(k))).toEqual(["deleteConversationContent"]);
  });
});
