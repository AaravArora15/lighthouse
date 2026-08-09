/**
 * The classifier client, and the promise it makes: **it can never hurt the student.**
 *
 * Offline, like every other suite here. `fetch` is stubbed rather than called, which is
 * not a compromise: what is being asserted is how this module behaves when the network
 * misbehaves, and the only reliable way to produce a timeout, a 502 and a garbage body on
 * demand is to write them.
 *
 * The cases below are the ones that actually happen in deployment. A free Hugging Face
 * Space sleeps after 48 hours and cold-starts in about 30 seconds, so the first request of
 * the day timing out is the *normal* path, not an exceptional one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifierUrl, hasClassifier, scoreConversation } from "@/lib/classifier";
import * as config from "@/lib/config";
import { Tier } from "@/lib/taxonomy";

const INPUT = {
  caseId: "live-abc",
  handle: "quietbird",
  startedAt: "2026-08-10T09:00:00.000Z",
  turns: [{ role: "student" as const, text: "i have been cutting my arms" }],
};

const GOOD_CARD = {
  caseId: "something-else",
  handle: "someone-else",
  tier: Tier.T4,
  confidence: 0.97,
  reasons: ["Immediate risk."],
  citedQuotes: [],
  gateFloor: Tier.T4,
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.LIGHTHOUSE_CLASSIFIER_URL = "http://scorer.test";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env.LIGHTHOUSE_CLASSIFIER_URL;
});

function respondWith(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    ({ ok, status, json: async () => body }) as unknown as Response,
  ) as unknown as typeof fetch;
}

describe("configuration", () => {
  it("reports no classifier when the URL is unset", async () => {
    delete process.env.LIGHTHOUSE_CLASSIFIER_URL;
    expect(hasClassifier()).toBe(false);

    const result = await scoreConversation(INPUT);
    expect(result.outcome).toBe("not_configured");
    expect(result.card).toBeNull();
  });

  it("does not make a request at all when unconfigured", async () => {
    delete process.env.LIGHTHOUSE_CLASSIFIER_URL;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await scoreConversation(INPUT);
    expect(spy).not.toHaveBeenCalled();
  });

  it("strips a trailing slash so the path never doubles up", () => {
    process.env.LIGHTHOUSE_CLASSIFIER_URL = "http://scorer.test/";
    expect(classifierUrl()).toBe("http://scorer.test");
  });
});

describe("a good response", () => {
  it("returns the card", async () => {
    respondWith(GOOD_CARD);
    const result = await scoreConversation(INPUT);
    expect(result.outcome).toBe("scored");
    expect(result.card?.tier).toBe(Tier.T4);
  });

  it("clears the gate-only marker", async () => {
    respondWith({ ...GOOD_CARD, awaitingClassifier: true });
    const result = await scoreConversation(INPUT);
    // The service sets this false itself; pinning it here too means a stale or replayed
    // response cannot leave a scored card claiming it was never scored.
    expect(result.card?.awaitingClassifier).toBe(false);
  });

  it("pins the identity to the case we asked about", async () => {
    // The stub deliberately answers with a different caseId and handle. A card describing
    // someone else must never be written onto this student's case.
    respondWith(GOOD_CARD);
    const result = await scoreConversation(INPUT);
    expect(result.card?.caseId).toBe("live-abc");
    expect(result.card?.handle).toBe("quietbird");
  });
});

describe("every way it can fail", () => {
  it("survives a 500", async () => {
    respondWith({ error: "boom" }, false, 500);
    const result = await scoreConversation(INPUT);
    expect(result.outcome).toBe("unavailable");
    expect(result.card).toBeNull();
  });

  it("survives a 503 from a service with no checkpoint", async () => {
    respondWith({ detail: "missing turn_model" }, false, 503);
    expect((await scoreConversation(INPUT)).card).toBeNull();
  });

  it("survives a connection refused", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await scoreConversation(INPUT);
    expect(result.outcome).toBe("unavailable");
    expect(result.card).toBeNull();
  });

  it("survives a body that is not a card", async () => {
    // An HTML error page from a proxy parses as *something*. A card with no tier would
    // render a blank badge on the queue, which is worse than the honest gate-only card.
    respondWith({ message: "gateway timeout" });
    const result = await scoreConversation(INPUT);
    expect(result.outcome).toBe("bad_response");
    expect(result.card).toBeNull();
  });

  it("survives a card with a tier but no reasons", async () => {
    respondWith({ tier: "T4" });
    expect((await scoreConversation(INPUT)).outcome).toBe("bad_response");
  });

  it("survives null", async () => {
    respondWith(null);
    expect((await scoreConversation(INPUT)).card).toBeNull();
  });

  it("reports a timeout as a timeout, not as an error", async () => {
    // A sleeping Space is the expected first request of the day, and the distinction
    // matters in the logs: a timeout is normal, unreachable means something is wrong.
    globalThis.fetch = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    const result = await scoreConversation(INPUT);
    expect(result.outcome).toBe("timeout");
    expect(result.card).toBeNull();
  });

  it("never throws, whatever comes back", async () => {
    for (const misbehave of [
      () => {
        throw new Error("nope");
      },
      () => {
        throw "a string, not an Error";
      },
    ]) {
      globalThis.fetch = vi.fn(misbehave) as unknown as typeof fetch;
      await expect(scoreConversation(INPUT)).resolves.toBeTruthy();
    }
  });
});

describe("the timeout is actually wired", () => {
  it("passes an abort signal", async () => {
    const spy = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => GOOD_CARD }) as unknown as Response,
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    await scoreConversation(INPUT);

    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Without this, a slow response holds the student's connection open indefinitely.
    expect(init.signal?.aborted).toBe(false);
  });

  it("uses the mirrored timeout constant rather than a local number", () => {
    // MIRRORED in config.py; `ml/tests/test_ts_conformance.py` fails if the two drift.
    expect(config.CLASSIFIER_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(config.CLASSIFIER_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
  });
});
