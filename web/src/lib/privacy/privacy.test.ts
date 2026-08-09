/**
 * Privacy behaviour tests — the day 8 gate.
 *
 * These check the promises `docs/context.md` §11 makes to a student, in the terms the
 * student was promised them:
 *
 *   "your name is not stored"          -> redaction runs and is asserted at the boundary
 *   "a leak does not expose you"       -> the sealed value is unreadable without the key
 *   "nobody reads it without a record" -> every disclosure produces an audit entry
 *   "you can see who looked"           -> that entry names the counsellor and the reason
 *
 * Offline by construction: regex, AES from node:crypto, and pure policy functions. No
 * database, no network, no key beyond the one this file sets for itself.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { decide, canEverUnseal } from "@/lib/privacy/disclosure";
import { looksIdentifying, redact, redactTranscript } from "@/lib/privacy/redact";
import { SealError, seal, unseal } from "@/lib/privacy/seal";
import { Tier } from "@/lib/taxonomy";

const COUNSELLOR = "counsellor-1";
const GOOD_REASON = "Escalating to the safeguarding lead, need the name to make the referral";

beforeAll(() => {
  // A test-only key. Never the deployment one: a suite that needs the real key is a
  // suite that cannot run in CI, and a secret in a test fixture is a secret in git.
  process.env.LIGHTHOUSE_PII_KEY = Buffer.alloc(32, 7).toString("base64");
});

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

describe("redaction removes what identifies a student", () => {
  it.each([
    ["phone", "call me on 07700 900123 after school", "07700 900123"],
    ["email", "my email is alex.smith@school.uk", "alex.smith@school.uk"],
    ["handle", "he posted it on @kai_r_2011", "kai_r_2011"],
    ["url", "it's all on https://insta.com/x/y", "https://insta.com/x/y"],
    ["address", "he followed me to 12 Elm Road", "12 Elm Road"],
    ["name", "Kai pushed me down the stairs", "Kai"],
    ["name", "a boy called Jamie started it", "Jamie"],
  ])("removes a %s", (_type, input, secret) => {
    const { redacted } = redact(input);
    expect(redacted).not.toContain(secret);
    expect(redacted).toMatch(/\[\w+( \d+)?\]/);
  });

  it("keeps the harm intact while removing the identity", () => {
    // The whole point. A counsellor must still be able to read what happened.
    const { redacted } = redact("Kai says he'll batter me after school");
    expect(redacted).toContain("batter me");
    expect(redacted).toContain("after school");
    expect(redacted).not.toContain("Kai");
  });

  it("does not redact relationship words", () => {
    // "my [name] hits me" would delete the most important word in the sentence, and
    // there are a lot of mums — the word is not identifying on its own.
    const { redacted } = redact("my dad hits me when he has been drinking");
    expect(redacted).toBe("my dad hits me when he has been drinking");
  });

  it("gives the same person the same placeholder within a transcript", () => {
    const { redacted } = redact("Kai started it and then Kai told everyone");
    const matches = redacted.match(/\[name(?: \d+)?\]/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(new Set(matches).size).toBe(1);
  });

  it("distinguishes two different people", () => {
    const { redacted, spans } = redact("Kai told Jamie about it");
    expect(new Set(spans.map((s) => s.placeholder)).size).toBe(2);
    expect(redacted).toMatch(/\[name 1\]/);
    expect(redacted).toMatch(/\[name 2\]/);
  });

  it("returns spans whose offsets point at the original text", () => {
    const input = "Kai pushed me";
    const { spans } = redact(input);
    for (const span of spans) {
      expect(input.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("leaves ordinary distress untouched", () => {
    // Over-redaction destroys evidence. A transcript of placeholders is unreadable, and
    // the counsellor loses the account they were meant to act on.
    const plain = "nobody has spoken to me in about two weeks and i eat lunch on my own";
    expect(redact(plain).redacted).toBe(plain);
  });

  it("redacts every turn of a transcript and keeps the attribution", () => {
    const { redacted, spans } = redactTranscript([
      "Kai pushed me in the stairwell",
      "it happened again today",
      "you can reach me on 07700 900123",
    ]);
    expect(redacted[1]).toBe("it happened again today");
    expect(spans.some((s) => s.turnIndex === 0 && s.type === "name")).toBe(true);
    expect(spans.some((s) => s.turnIndex === 2 && s.type === "phone")).toBe(true);
  });
});

describe("lowercase names, which is how students actually type", () => {
  // The regression that matters most in this file. The first version of `redact` found
  // names by capitalisation and redacted 0 of 260 real student turns, while passing every
  // test in this suite — because the tests were written with capitals. These use the
  // corpus's own phrasing.
  const KNOWN = { people: ["kai"], places: ["science block stairwell"] };

  it("misses a lowercase name with no extracted entities, and that is the known gap", () => {
    const { redacted } = redact("kai took my bag off me");
    expect(redacted).toContain("kai");
  });

  it("redacts it once the extractor supplies the name", () => {
    const { redacted } = redact("kai took my bag off me", KNOWN);
    expect(redacted).not.toContain("kai");
    expect(redacted).toContain("[name]");
  });

  it("redacts a lowercase place too", () => {
    const { redacted } = redact(
      "kai says he'll batter me if i go near the science block stairwell again",
      KNOWN,
    );
    expect(redacted).toBe(
      "[name] says he'll batter me if i go near the [place] again",
    );
  });

  it("keeps the threat completely intact", () => {
    // The counsellor must still be able to read what was threatened.
    const { redacted } = redact("kai says he'll batter me after school", KNOWN);
    expect(redacted).toContain("batter me");
    expect(redacted).toContain("after school");
  });

  it("matches an extracted name in any casing", () => {
    for (const written of ["kai", "Kai", "KAI"]) {
      expect(redact(`${written} pushed me`, KNOWN).redacted).not.toContain(written);
    }
  });

  it("does not redact a substring of a longer word", () => {
    // "kai" must not eat the "kai" in "kaiser". Word boundaries, not substring search.
    expect(redact("we did the kaiser roll in food tech", KNOWN).redacted).toContain("kaiser");
  });

  it("an extracted entity outranks a regex heuristic on the same span", () => {
    const { spans } = redact("Kai told Jamie", { people: ["Kai"] });
    expect(spans.some((s) => s.text === "Kai" && s.type === "name")).toBe(true);
  });
});

describe("the storage boundary", () => {
  it("flags text that still looks identifying", () => {
    expect(looksIdentifying("call 07700 900123")).toBe(true);
    expect(looksIdentifying("i feel awful today")).toBe(false);
  });

  it("passes its own output", () => {
    // The property that makes `looksIdentifying` usable as a pre-write assertion:
    // redacted text must never trip it, or every insert would be rejected.
    for (const input of [
      "Kai pushed me down the stairs",
      "my email is alex@school.uk and my number is 07700 900123",
      "he followed me to 12 Elm Road after school",
    ]) {
      expect(looksIdentifying(redact(input).redacted)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------

describe("a database dump alone does not de-anonymise anyone", () => {
  it("produces ciphertext that does not contain the plaintext", () => {
    const sealed = seal("Kai Ramanathan");
    expect(sealed).not.toContain("Kai");
    expect(sealed).not.toContain("Ramanathan");
    expect(sealed.startsWith("v1.")).toBe(true);
  });

  it("cannot be read without the key", () => {
    const sealed = seal("Kai");
    const saved = process.env.LIGHTHOUSE_PII_KEY;
    delete process.env.LIGHTHOUSE_PII_KEY;
    try {
      expect(() =>
        unseal({ ciphertext: sealed, counsellorId: COUNSELLOR, reason: GOOD_REASON, caseId: "c1" }),
      ).toThrow(SealError);
    } finally {
      process.env.LIGHTHOUSE_PII_KEY = saved;
    }
  });

  it("cannot be read with the wrong key", () => {
    const sealed = seal("Kai");
    const saved = process.env.LIGHTHOUSE_PII_KEY;
    process.env.LIGHTHOUSE_PII_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      expect(() =>
        unseal({ ciphertext: sealed, counsellorId: COUNSELLOR, reason: GOOD_REASON, caseId: "c1" }),
      ).toThrow(/altered|key/i);
    } finally {
      process.env.LIGHTHOUSE_PII_KEY = saved;
    }
  });

  it("detects tampering rather than returning different plaintext", () => {
    // The reason for GCM over CBC. A console that could be made to display an
    // attacker-chosen name by flipping bits in a row would be worse than one showing
    // nothing.
    const sealed = seal("Kai");
    const [v, iv, tag, body] = sealed.split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 0xff;
    expect(() =>
      unseal({
        ciphertext: [v, iv, tag, flipped.toString("base64url")].join("."),
        counsellorId: COUNSELLOR,
        reason: GOOD_REASON,
        caseId: "c1",
      }),
    ).toThrow(SealError);
  });

  it("seals the same name to different ciphertext each time", () => {
    // Deterministic ciphertext would let anyone holding the table see that two
    // conversations name the same person — the exact inference encryption is meant to
    // prevent. Cross-conversation matching is done deliberately, elsewhere, with HMAC.
    expect(seal("Kai")).not.toBe(seal("Kai"));
  });

  it("round-trips through a real unseal", () => {
    const result = unseal({
      ciphertext: seal("Kai"),
      counsellorId: COUNSELLOR,
      reason: GOOD_REASON,
      caseId: "syn-081",
    });
    expect(result.plaintext).toBe("Kai");
    expect(result.audit.action).toBe("unsealed_pii");
    expect(result.audit.counsellorId).toBe(COUNSELLOR);
    expect(result.audit.reason).toBe(GOOD_REASON);
  });
});

describe("unsealing is an event, not an accessor", () => {
  it("refuses without a substantive reason", () => {
    expect(() =>
      unseal({ ciphertext: seal("Kai"), counsellorId: COUNSELLOR, reason: "need it", caseId: "c1" }),
    ).toThrow(/at least 20/);
  });

  it("refuses without an identified counsellor", () => {
    expect(() =>
      unseal({ ciphertext: seal("Kai"), counsellorId: "", reason: GOOD_REASON, caseId: "c1" }),
    ).toThrow(/identified counsellor/);
  });

  it("always returns an audit record alongside the plaintext", () => {
    // There is no code path that yields a name without one. That is enforced by the
    // return type, and asserted here so a future convenience wrapper cannot quietly
    // drop it.
    const result = unseal({
      ciphertext: seal("Kai"),
      counsellorId: COUNSELLOR,
      reason: GOOD_REASON,
      caseId: "c1",
    });
    expect(result.audit).toBeTruthy();
    expect(Date.parse(result.audit.at)).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------------------
// Tiered disclosure
// ---------------------------------------------------------------------------------------

describe("tiered disclosure", () => {
  it("lets a counsellor read a card with no reason", () => {
    const d = decide({ level: "card", tier: Tier.T2, counsellorId: COUNSELLOR });
    expect(d.allowed).toBe(true);
    expect(d.audit?.action).toBe("viewed_card");
  });

  it("still logs a card view", () => {
    // The student was promised they can see who looked. "Only the interesting views are
    // logged" is not that promise.
    const d = decide({ level: "card", tier: Tier.T0, counsellorId: COUNSELLOR });
    expect(d.audit).not.toBeNull();
  });

  it("requires a reason for the full transcript", () => {
    const d = decide({ level: "transcript", tier: Tier.T3, counsellorId: COUNSELLOR });
    expect(d.allowed).toBe(false);
    expect(d.refusal).toMatch(/reason/i);
  });

  it("allows the transcript with a reason, and records it", () => {
    const d = decide({
      level: "transcript",
      tier: Tier.T3,
      counsellorId: COUNSELLOR,
      reason: "preparing the referral meeting",
    });
    expect(d.allowed).toBe(true);
    expect(d.audit?.reason).toBe("preparing the referral meeting");
  });

  it("refuses identity on an unescalated case even at T4", () => {
    // A tier is a machine judgement. Escalation is a human one, and only the second
    // unlocks a name.
    const d = decide({
      level: "identity",
      tier: Tier.T4,
      counsellorId: COUNSELLOR,
      reason: GOOD_REASON,
      escalated: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.refusal).toMatch(/escalate/i);
  });

  it("allows identity once escalated, with a reason", () => {
    const d = decide({
      level: "identity",
      tier: Tier.T4,
      counsellorId: COUNSELLOR,
      reason: GOOD_REASON,
      escalated: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.audit?.action).toBe("unsealed_pii");
  });

  it("demands a longer reason for identity than for a transcript", () => {
    const short = "referral prep";
    expect(
      decide({ level: "transcript", tier: Tier.T3, counsellorId: COUNSELLOR, reason: short })
        .allowed,
    ).toBe(true);
    expect(
      decide({
        level: "identity",
        tier: Tier.T3,
        counsellorId: COUNSELLOR,
        reason: short,
        escalated: true,
      }).allowed,
    ).toBe(false);
  });

  it("refuses everything to an unidentified caller", () => {
    for (const level of ["card", "transcript", "identity"] as const) {
      const d = decide({ level, tier: Tier.T4, counsellorId: "", reason: GOOD_REASON, escalated: true });
      expect(d.allowed, level).toBe(false);
    }
  });

  it("never returns an audit record for a refused request", () => {
    // A refusal must not look like an access in the log the student reads.
    const d = decide({ level: "identity", tier: Tier.T4, counsellorId: COUNSELLOR, reason: "x" });
    expect(d.allowed).toBe(false);
    expect(d.audit).toBeNull();
  });

  it("only ever offers unsealing on escalated tiers", () => {
    expect(canEverUnseal(Tier.T4)).toBe(true);
    expect(canEverUnseal(Tier.T3)).toBe(true);
    expect(canEverUnseal(Tier.T2)).toBe(false);
    expect(canEverUnseal(Tier.T0)).toBe(false);
  });
});
