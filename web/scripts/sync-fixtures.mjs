/**
 * Copy the fixtures the web app reads into `src/fixtures/`, so they are compiled into the
 * bundle instead of read off disk at runtime.
 *
 *     npm run fixtures:sync
 *
 * ## Why this exists
 *
 * `cards.ts` and `patterns.ts` used to do `readFileSync(process.cwd() + "/../fixtures/…")`.
 * That works locally, where the repo is laid out around the app, and **500s on Vercel**,
 * where a serverless function gets a bundle rather than a checkout: `../fixtures` is
 * outside the function root, and `join(process.cwd(), "..")` is not statically analysable
 * so Next's file tracing cannot include it either. Verified by hiding the directory and
 * hitting a production build — `/console` returned 500 with ENOENT.
 *
 * A static `import` of a file under `src/` has none of those problems. The compiler
 * inlines it, there is no filesystem access at request time, and a missing file is a build
 * error rather than a page that fails in production and works in development.
 *
 * ## Why the copies are committed
 *
 * A gitignored generated directory would mean a fresh clone could not run `npm test` until
 * something had built first, and a static import of a missing file is a hard failure. So
 * the copies are checked in and `fixtures.test.ts` asserts they match the source
 * byte-for-byte — the same staleness-guard pattern `ml/tests/test_ts_conformance.py`
 * already uses for the gate snapshot. Regenerate after any change to the Python writers.
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "..", "fixtures");
const TARGET = join(HERE, "..", "src", "fixtures");

/** Only what the running app reads. Test-only fixtures stay out of the bundle. */
const FILES = ["escalation_cards.json", "pattern_alerts.json"];

mkdirSync(TARGET, { recursive: true });

let changed = 0;
for (const name of FILES) {
  const from = join(SOURCE, name);
  const to = join(TARGET, name);

  let existing = null;
  try {
    existing = readFileSync(to);
  } catch {
    // Not there yet: first run, or someone deleted it.
  }

  const incoming = readFileSync(from);
  if (existing && existing.equals(incoming)) continue;

  copyFileSync(from, to);
  changed += 1;
  console.log(`synced ${name}`);
}

console.log(
  changed === 0
    ? `fixtures already up to date (${FILES.length} files)`
    : `synced ${changed} of ${FILES.length} fixtures — commit src/fixtures/`,
);
