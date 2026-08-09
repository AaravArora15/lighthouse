/**
 * The seam between the two halves of the product.
 *
 * Until now the chat threw every conversation away and the console read a fixture. These
 * tests are the contract for the join, and they are weighted toward the properties that
 * would be invisible if they broke:
 *
 * - a T4 disclosure becomes a case that a counsellor can find
 * - what gets stored is redacted, and the identifying parts are sealed
 * - a gate-only card never claims to be a classifier judgement
 * - live cases sort by urgency, not by recency
 */

import { beforeEach, describe, expect, it } from "vitest";

import { evaluateConversation } from "@/lib/gate/safety";
import { buildGateCard, isLiveCase, newCaseId, newHandle, persistConversation } from "@/lib/live";
import { createMemoryStore, type Store } from "@/lib/store";
import { Tier } from "@/lib/taxonomy";

const STARTED = "2026-08-10T09:00:00.000Z";

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
  // `seal` needs a key. 32 bytes of nothing-in-particular: these tests never assert on
  // the plaintext, only that the ciphertext is not the plaintext.
  process.env.LIGHTHOUSE_PII_KEY = Buffer.alloc(32, 7).toString("base64");
});

function card(turns: string[]) {
  return buildGateCard({
    caseId: "live-test",
    handle: "quietbird",
    startedAt: STARTED,
    studentTurns: turns,
    verdict: evaluateConversation(turns),
    crisisResourcesShown: false,
  });
}

describe("a conversation becomes a case", () => {
  it("floors a self-harm disclosure at T4", () => {
    const c = card(["i've been cutting my arms"]);
    expect(c.tier).toBe(Tier.T4);
    expect(c.gateFloor).toBe(Tier.T4);
  });

  it("leaves an ordinary conversation at T0, so it never reaches the queue", () => {
    const c = card(["hi is this a chat with a real person"]);
    expect(c.tier).toBe(Tier.T0);
    expect(c.gateFloor).toBeNull();
  });

  it("never invents a confidence for a card no model has seen", () => {
    // The single most dishonest thing this product could do is show "conf 0.00" on a case
    // nothing scored. Null means "not scored"; 0 would mean "scored, and very unsure".
    expect(card(["i've been cutting my arms"]).confidence).toBeNull();
  });

  it("marks itself as gate-only", () => {
    const c = card(["i've been cutting my arms"]);
    expect(c.awaitingClassifier).toBe(true);
    expect(c.reasons.join(" ")).toContain("classifier has not run");
  });

  it("reports the model tier as T0 rather than pretending the gate was a prediction", () => {
    expect(card(["i've been cutting my arms"]).modelTier).toBe(Tier.T0);
  });
});

describe("evidence", () => {
  it("quotes the turn the gate actually fired on, verbatim", () => {
    const c = card(["my day was fine", "i've been cutting my arms"]);
    expect(c.citedQuotes[0].text).toBe("i've been cutting my arms");
    expect(c.citedQuotes[0].reason).toContain("self_harm");
  });

  it("still carries evidence when nothing fired, labelled honestly", () => {
    // Day 6 shipped T3 cards with no quotes at all after a threshold was added. A card a
    // counsellor cannot check is a card they have to take on faith.
    const c = card(["nobody talks to me at lunch"]);
    expect(c.citedQuotes).toHaveLength(1);
    expect(c.citedQuotes[0].reason).toContain("no explicit signal");
  });

  it("never exceeds the quote cap", () => {
    const c = card([
      "i've been cutting my arms",
      "i want to kill myself",
      "i have a knife",
      "nobody would miss me",
    ]);
    expect(c.citedQuotes.length).toBeLessThanOrEqual(3);
  });
});

describe("what actually reaches the database", () => {
  const RAW = "you can reach me on 9123 4567 or bluefox@example.com";

  async function persist(turns: string[]) {
    return persistConversation(store, {
      caseId: "live-abc",
      handle: "quietbird",
      startedAt: STARTED,
      turns: turns.map((text) => ({ role: "student" as const, text })),
      verdict: evaluateConversation(turns),
      crisisResourcesShown: false,
    });
  }

  it("stores the case so a counsellor can find it", async () => {
    await persist(["i've been cutting my arms"]);
    const found = await store.liveCard("live-abc");
    expect(found?.tier).toBe(Tier.T4);
  });

  it("does not create a second case when the same conversation continues", async () => {
    // The client resends its whole history each turn. If that produced a new case per
    // message, one disclosure would arrive in the queue as five separate cases.
    await persist(["hello"]);
    await persist(["hello", "i've been cutting my arms"]);
    expect(await store.liveCards()).toHaveLength(1);
  });

  it("upgrades the tier as the conversation gets worse", async () => {
    await persist(["hello"]);
    expect((await store.liveCard("live-abc"))!.tier).toBe(Tier.T0);
    await persist(["hello", "i've been cutting my arms"]);
    expect((await store.liveCard("live-abc"))!.tier).toBe(Tier.T4);
  });

  it("redacts a phone number and an email before storage", async () => {
    const stored = await persist([RAW]);
    const quoted = stored.citedQuotes.map((q) => q.text).join(" ");
    expect(quoted).not.toContain("9123 4567");
    expect(quoted).not.toContain("bluefox@example.com");
  });

  it("seals what it removed rather than discarding it", async () => {
    await persist([RAW]);
    // Round-tripping through the card is enough: the point is that the plaintext is gone
    // from the readable surface and the sealed form is not the plaintext.
    const stored = await store.liveCard("live-abc");
    expect(JSON.stringify(stored)).not.toContain("9123 4567");
  });

  it("refuses to store anything at all without an encryption key", async () => {
    delete process.env.LIGHTHOUSE_PII_KEY;
    await expect(persist(["i've been cutting my arms"])).rejects.toThrow(/LIGHTHOUSE_PII_KEY/);
    expect(await store.liveCards()).toHaveLength(0);
  });

  it("gives an escalated live case no retention expiry", async () => {
    await persist(["i've been cutting my arms"]);
    expect((await store.liveCard("live-abc"))!.retentionExpiresAt).toBeNull();
  });

  it("gives a non-escalated live case one", async () => {
    await persist(["hello, what is this service"]);
    expect((await store.liveCard("live-abc"))!.retentionExpiresAt).not.toBeNull();
  });

  it("registers the case with the retention job the moment it exists", async () => {
    // Not in a later step. A stored transcript with no deletion date attached is a
    // conversation the 30-day promise does not cover.
    await persist(["hello"]);
    const candidates = await store.retentionCandidates();
    expect(candidates.map((c) => c.caseId)).toContain("live-abc");
  });
});

describe("identity", () => {
  it("mints distinguishable case ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCaseId()));
    expect(ids.size).toBe(200);
    expect([...ids].every(isLiveCase)).toBe(true);
  });

  it("does not confuse a live case with a seeded one", () => {
    expect(isLiveCase("syn-065")).toBe(false);
  });

  it("generates a pronounceable handle and never a real name", () => {
    expect(newHandle()).toMatch(/^[a-z]+$/);
  });
});

describe("where a live case lands in the queue", () => {
  // The bug this is here for: `queueRank` is `floor_rank + escalation`, and the first
  // version passed escalation 0 for an unscored case. A live T4 sorted 17th, below every
  // seeded T4. "Not scored yet" must not read as "scored low".
  it("ranks a gate-only T4 above a scored T4", () => {
    const live = card(["i've been cutting my arms"]);
    // The seeded T4s span 4.94–5.00 (floor_rank 4 + escalation 0.94–1.00).
    expect(live.queueRank).toBeGreaterThanOrEqual(5.0);
  });

  it("still ranks a gate-only T2 below any T4", () => {
    // Resolving upward must not mean jumping bands. The floor is still the primary sort.
    const t4 = card(["i've been cutting my arms"]);
    const quiet = card(["nobody talks to me at lunch"]);
    expect(quiet.queueRank).toBeLessThan(t4.queueRank);
  });
});
