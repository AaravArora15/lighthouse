/**
 * Cross-runtime conformance: the TypeScript gate must agree with the Python gate exactly.
 *
 * The gate exists twice, in two languages, and that is a liability unless something forces
 * the copies to agree. This is that something. It runs the TS gate over the same 80
 * synthetic conversations, the same 245 student turns, and the same 29 adversarial probes
 * that `ml/lighthouse/gate/export_expectations.py` ran the Python gate over, and diffs
 * every field of every verdict.
 *
 * A drift here is not a style bug. It means a student's crisis banner would appear in one
 * runtime and not the other, which is the exact failure the two-runtime design was chosen
 * to avoid.
 *
 * Offline by construction: two files on disk, no network, no key, no model weights.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as config from "@/lib/config";
import { patternCount } from "@/lib/gate/patterns";
import {
  evaluateConversation,
  evaluateTurn,
  requiresCrisisResources,
  verdictToDict,
} from "@/lib/gate/safety";
import { Tier } from "@/lib/taxonomy";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const FIXTURES = join(REPO_ROOT, "fixtures");

interface VerdictDict {
  score: number;
  level: string;
  is_high: boolean;
  is_grey: boolean;
  indicators: string[];
  floor: string | null;
  ceiling: string | null;
  hits: Array<{
    category: string;
    pattern: string;
    severity: string;
    turn_index: number;
    text: string;
  }>;
}

interface Expectations {
  pattern_count: Record<string, number>;
  mirrored_config: Record<string, number | string | Record<string, number>>;
  probes: Array<{ text: string; verdict: VerdictDict }>;
  conversations: Array<{
    id: string;
    tier: string;
    n_student_turns: number;
    conversation: VerdictDict;
    turns: VerdictDict[];
  }>;
}

const expectations: Expectations = JSON.parse(
  readFileSync(join(FIXTURES, "gate_expectations.json"), "utf8"),
);

/** The student turns, read from the same corpus the Python side read. */
const studentTurnsById = new Map<string, string[]>(
  readFileSync(join(FIXTURES, "synthetic_conversations.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const row = JSON.parse(line) as {
        id: string;
        turns: Array<{ role: string; text: string }>;
      };
      // Only the student speaks to the gate. Scoring the assistant's own words would make
      // the tool escalate itself for saying "crisis".
      return [row.id, row.turns.filter((t) => t.role === "student").map((t) => t.text)];
    }),
);

describe("the fixtures themselves", () => {
  it("cover 85 conversations and 260 student turns", () => {
    expect(expectations.conversations).toHaveLength(85);
    const turns = expectations.conversations.reduce((n, c) => n + c.n_student_turns, 0);
    expect(turns).toBe(260);
  });

  it("agrees with the corpus on how many student turns each conversation has", () => {
    for (const c of expectations.conversations) {
      expect(studentTurnsById.get(c.id)).toHaveLength(c.n_student_turns);
    }
  });
});

describe("mirrored constants", () => {
  // config.py and config.ts both carry MIRRORED markers. This is what makes the marker
  // mean something: a value edited on one side and not the other fails here.
  it.each([
    ["GATE_HIGH_SCORE", config.GATE_HIGH_SCORE],
    ["GATE_GREY_SCORE", config.GATE_GREY_SCORE],
    ["GATE_FLOOR_MIN_WEIGHT", config.GATE_FLOOR_MIN_WEIGHT],
    ["GATE_CEILING_WITHOUT_T4_EVIDENCE", config.GATE_CEILING_WITHOUT_T4_EVIDENCE],
    ["MAX_CITED_QUOTES", config.MAX_CITED_QUOTES],
    ["CONCERN_THRESHOLD", config.CONCERN_THRESHOLD],
    ["COUNSELLOR_WEEKLY_BUDGET", config.COUNSELLOR_WEEKLY_BUDGET],
    ["RETENTION_DAYS_NON_ESCALATED", config.RETENTION_DAYS_NON_ESCALATED],
    ["CLASSIFIER_TIMEOUT_SECONDS", config.CLASSIFIER_TIMEOUT_SECONDS],
  ])("%s matches config.py", (name, value) => {
    expect(value).toEqual(expectations.mirrored_config[name]);
  });

  it("GATE_SEVERITY_WEIGHTS matches config.py", () => {
    expect({ ...config.GATE_SEVERITY_WEIGHTS }).toEqual(
      expectations.mirrored_config.GATE_SEVERITY_WEIGHTS,
    );
  });

  it("has the same number of patterns per category", () => {
    expect(patternCount()).toEqual(expectations.pattern_count);
  });
});

/**
 * Compare one verdict field by field rather than with a single deep-equal, so a failure
 * names the field that drifted instead of dumping two large objects side by side.
 */
function expectVerdictMatches(actual: VerdictDict, expected: VerdictDict, where: string) {
  // Float, so compare numerically. Python rounds to 4dp on the way out; so do we.
  expect(actual.score, `${where}: score`).toBeCloseTo(expected.score, 4);
  expect(actual.level, `${where}: level`).toBe(expected.level);
  expect(actual.is_high, `${where}: is_high`).toBe(expected.is_high);
  expect(actual.is_grey, `${where}: is_grey`).toBe(expected.is_grey);
  expect(actual.floor, `${where}: floor`).toBe(expected.floor);
  expect(actual.ceiling, `${where}: ceiling`).toBe(expected.ceiling);
  expect(actual.indicators, `${where}: indicators`).toEqual(expected.indicators);
  // Hit-for-hit, including the matched substring. A port that gets the floor right by
  // matching a different pattern is not a port, and this is where that shows up.
  expect(actual.hits, `${where}: hits`).toEqual(expected.hits);
}

describe("conversation-level verdicts", () => {
  it.each(expectations.conversations.map((c) => [c.id, c] as const))(
    "%s matches Python",
    (id, expected) => {
      const turns = studentTurnsById.get(id);
      expect(turns, `${id} missing from the corpus`).toBeDefined();
      const actual = verdictToDict(evaluateConversation(turns!)) as unknown as VerdictDict;
      expectVerdictMatches(actual, expected.conversation, id);
    },
  );
});

describe("per-turn verdicts, the live-chat path", () => {
  // This is the path the chat route actually calls, so it matters more than the
  // conversation-level one for day 5. 245 assertions.
  it.each(expectations.conversations.map((c) => [c.id, c] as const))(
    "%s: every student turn matches Python",
    (id, expected) => {
      const turns = studentTurnsById.get(id)!;
      turns.forEach((text, i) => {
        const actual = verdictToDict(evaluateTurn(text, i)) as unknown as VerdictDict;
        expectVerdictMatches(actual, expected.turns[i], `${id} turn ${i}`);
      });
    },
  );
});

describe("adversarial probes", () => {
  // Each of these is a bug the gate actually had, or an adversarial phrasing from the
  // day 3 corpus. A regex that ports "almost right" fails here, not on ordinary chat.
  it.each(expectations.probes.map((p) => [p.text || "(empty)", p] as const))(
    "%s",
    (label, probe) => {
      const actual = verdictToDict(evaluateTurn(probe.text)) as unknown as VerdictDict;
      expectVerdictMatches(actual, probe.verdict, label);
    },
  );
});

describe("the invariant that actually matters", () => {
  it("renders crisis resources on exactly the conversations Python floors at T4", () => {
    const pythonT4 = expectations.conversations
      .filter((c) => c.conversation.floor === Tier.T4)
      .map((c) => c.id);

    const tsT4 = expectations.conversations
      .filter((c) => requiresCrisisResources(evaluateConversation(studentTurnsById.get(c.id)!)))
      .map((c) => c.id);

    expect(tsT4).toEqual(pythonT4);
    // Not a vacuous pass: the corpus has 16 T4 conversations and the gate reaches all of
    // them on its own. If this number moves, the corpus or the gate changed.
    expect(tsT4.length).toBeGreaterThan(0);
  });

  it("never floors a benign conversation", () => {
    // 26 benign (T0/T1) conversations, 0 false-positive floors. Day 3's headline number,
    // re-proved in the runtime that actually faces the student. The day 7 cluster seeds
    // are all T2/T3, so this count is deliberately unchanged by them.
    const benign = expectations.conversations.filter(
      (c) => c.tier === Tier.T0 || c.tier === Tier.T1,
    );
    expect(benign.length).toBe(26);
    for (const c of benign) {
      const verdict = evaluateConversation(studentTurnsById.get(c.id)!);
      expect(verdict.floor, `${c.id} floored at ${verdict.floor}`).toBeNull();
    }
  });
});
