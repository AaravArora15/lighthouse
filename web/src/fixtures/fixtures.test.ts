/**
 * The bundled fixture copies must match the Python-generated originals.
 *
 * `src/fixtures/` exists because a serverless function gets a bundle rather than a
 * checkout, so `../fixtures` is not readable at request time (see `cards.ts`). The cost of
 * that fix is a second copy, and a second copy of anything is a thing that drifts.
 *
 * So this test is the whole justification for committing the copies rather than
 * gitignoring them: regenerate the cards in `ml/` and forget `npm run fixtures:sync`, and
 * the console silently keeps serving yesterday's tiers. The same staleness-guard pattern
 * `ml/tests/test_ts_conformance.py` uses for the gate snapshot.
 *
 * Byte-for-byte, not parsed-and-compared. A whitespace-only difference still means the
 * generator ran and the copy did not, which is the condition worth catching.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = join(process.cwd(), "..", "fixtures");
const COPY = join(process.cwd(), "src", "fixtures");

const FILES = ["escalation_cards.json", "pattern_alerts.json"];

describe("bundled fixtures", () => {
  it.each(FILES)("%s is byte-identical to the generated original", (name) => {
    const source = readFileSync(join(SOURCE, name));
    const copy = readFileSync(join(COPY, name));

    expect(
      copy.equals(source),
      `src/fixtures/${name} is stale. Run: npm run fixtures:sync`,
    ).toBe(true);
  });

  it("copies only what the running app reads", () => {
    // Test-only fixtures (gate_expectations.json, the raw conversations) stay out of the
    // bundle. They are large, they are read by tests that run from a checkout anyway, and
    // synthetic_conversations.jsonl is the transcript text — which the console is not
    // supposed to be able to render without going through the disclosure gate.
    expect(FILES).toEqual(["escalation_cards.json", "pattern_alerts.json"]);
  });
});
