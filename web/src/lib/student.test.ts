/**
 * What the student is told, and what they must never be told.
 *
 * The negative assertions are the point of this file. `docs/context.md` §11 promised the
 * student a visible audit log and a readable consent screen, and for four days the
 * counsellor's screen displayed *"Shown to you because it is shown to the student"* over a
 * log no student could reach. These tests exist so that promise stays kept, and so the
 * rule about not showing a child a machine-generated severity label about themselves is
 * enforced rather than remembered.
 */

import { describe, expect, it } from "vitest";

import type { EscalationCard } from "@/lib/cards";
import { CONSENT_LINES, REDACTION_NOTE, retentionFor, statusFor } from "@/lib/student";
import { Tier } from "@/lib/taxonomy";

function card(overrides: Partial<EscalationCard> = {}): EscalationCard {
  return {
    caseId: "live-abc",
    handle: "quietbird",
    tier: Tier.T2,
    confidence: 0.81,
    tierFloorReason: "The safety gate floors this conversation at T4.",
    gateFloor: Tier.T4,
    gateIndicators: ["self_harm_intent"],
    citedQuotes: [],
    entities: { people: [], places: [], platforms: [] },
    sessionTimeline: [],
    deltaSinceLastSession: null,
    patternClusterId: null,
    retentionExpiresAt: "2026-09-09T00:00:00.000Z",
    reasons: ["Immediate risk. Break-glass now."],
    queueRank: 5,
    escalation: 0.94,
    modelTier: Tier.T4,
    slaHours: 0,
    action: "Break-glass now",
    crisisResourcesShown: true,
    nStudentTurns: 3,
    ...overrides,
  };
}

const ALL_TIERS = [Tier.T0, Tier.T1, Tier.T2, Tier.T3, Tier.T4];

describe("the student is never shown a severity label about themselves", () => {
  it.each(ALL_TIERS)("says nothing about the tier on a %s case", (tier) => {
    const s = statusFor(card({ tier }));
    const text = `${s.headline} ${s.detail ?? ""}`;

    // A tier is a routing decision made partly by a regex bank. Telling a thirteen-year-old
    // a computer classified them as a risk to life is a clinical-sounding claim this
    // product has no standing to make, with nobody on the page to talk them through it.
    for (const label of ["T0", "T1", "T2", "T3", "T4"]) {
      expect(text).not.toContain(label);
    }
  });

  it.each(ALL_TIERS)("uses no clinical or severity vocabulary on a %s case", (tier) => {
    const s = statusFor(card({ tier }));
    const text = `${s.headline} ${s.detail ?? ""}`.toLowerCase();
    for (const word of ["risk", "severity", "tier", "score", "classified", "flagged", "crisis level"]) {
      expect(text).not.toContain(word);
    }
  });

  it.each(ALL_TIERS)("still tells them what happens next on a %s case", (tier) => {
    const s = statusFor(card({ tier }));
    expect(s.headline.length).toBeGreaterThan(20);
    expect(s.headline.endsWith(".")).toBe(true);
  });
});

describe("what happens next is accurate", () => {
  it("promises contact on an escalated case", () => {
    expect(statusFor(card({ tier: Tier.T4 })).someoneWillRead).toBe(true);
    expect(statusFor(card({ tier: Tier.T3 })).someoneWillRead).toBe(true);
  });

  it("promises contact on a queued case", () => {
    expect(statusFor(card({ tier: Tier.T2 })).someoneWillRead).toBe(true);
  });

  it.each([Tier.T0, Tier.T1])("does not promise contact on a %s case", (tier) => {
    // Saying "someone will be in touch" to a student nobody is going to contact is the
    // one lie this page could tell that would actually hurt.
    expect(statusFor(card({ tier })).someoneWillRead).toBe(false);
  });

  it("does not make a student feel dismissed when nothing is escalated", () => {
    const s = statusFor(card({ tier: Tier.T0 }));
    expect(s.detail).toContain("not a judgement");
    expect(s.detail).toContain("any time");
  });

  it("points a T4 student at the crisis numbers on the page", () => {
    expect(statusFor(card({ tier: Tier.T4 })).detail).toContain("day and night");
  });
});

describe("retention, in words a student can act on", () => {
  it("gives a real date when there is one", () => {
    const text = retentionFor(card({ retentionExpiresAt: "2026-09-09T00:00:00.000Z" }));
    expect(text).toMatch(/September/);
    expect(text).toContain("30 days");
  });

  it("explains honestly when there is no deletion date on an escalated case", () => {
    const text = retentionFor(card({ tier: Tier.T4, retentionExpiresAt: null }));
    // Not "kept forever" and not silence. It says why, and where to ask.
    expect(text).toContain("not deleted automatically");
    expect(text).toContain("ask your school");
  });

  it("promises deletion is real rather than hidden", () => {
    expect(retentionFor(card())).toContain("including us");
  });
});

describe("consent", () => {
  it("is two sentences, not a policy document", () => {
    expect(CONSENT_LINES).toHaveLength(2);
  });

  it("covers anonymity and who reads it, which is what §11 asked for", () => {
    const text = CONSENT_LINES.join(" ").toLowerCase();
    expect(text).toContain("nobody here knows who you are");
    expect(text).toContain("counsellor");
    expect(text).toContain("see exactly who opened it");
  });

  it("stays readable, with no sentence running long", () => {
    // "A consent screen a 12-year-old can read" is the actual requirement.
    for (const line of CONSENT_LINES) {
      expect(line.length).toBeLessThan(200);
    }
  });
});

describe("the redaction note", () => {
  it("explains the placeholders a student will actually see", () => {
    expect(REDACTION_NOTE).toContain("[phone]");
  });

  it("says the counsellor sees the same thing, because they do", () => {
    expect(REDACTION_NOTE).toContain("the same thing you do");
  });
});
