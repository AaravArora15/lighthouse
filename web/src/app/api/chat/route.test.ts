/**
 * What `POST /api/chat` refuses to do.
 *
 * The route is unauthenticated, unmetered, and calls a paid model. The property under
 * test is not "long conversations are tidy" — it is that **the size of a bill is not a
 * client-side decision**. `parseMessages` is the only thing standing between an open
 * endpoint and a caller who sends four thousand turns, so its cap is worth a test that
 * fails loudly if someone relaxes it.
 *
 * Offline, per CLAUDE.md: no API key, no database, no network. The store is pinned to
 * memory so a stray `DATABASE_URL` in a developer's shell cannot point this at Neon.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/chat/route";
import * as config from "@/lib/config";

beforeAll(() => {
  process.env.LIGHTHOUSE_STORE = "memory";
  delete process.env.ANTHROPIC_API_KEY;
  process.env.LIGHTHOUSE_PII_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Exactly `count` alternating turns, ending on a student one as the client always does. */
function conversation(count: number) {
  const turns = Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "student" : "assistant",
    text: "i don't know what to do",
  }));
  turns[turns.length - 1].role = "student";
  return turns;
}

describe("the message array is bounded before anything is spent", () => {
  it("rejects a 5,000-message POST rather than billing it", async () => {
    const response = await post({ messages: conversation(5000) });

    expect(response.status).toBe(400);
    // A 400 and not an SSE stream: the request never reached the gate, the store, or the
    // model. If this ever returns `text/event-stream`, the cap has been moved downstream
    // of the spending.
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  it("rejects one turn past the cap", async () => {
    const response = await post({ messages: conversation(config.MAX_CONVERSATION_TURNS + 1) });
    expect(response.status).toBe(400);
  });

  it("still accepts a conversation at the cap", async () => {
    const response = await post({ messages: conversation(config.MAX_CONVERSATION_TURNS) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    // No key in this process, so the reply is scripted and the header says so. What
    // matters here is that the gate ran and the student got a stream.
    expect(response.headers.get("X-Lighthouse-Intake")).toBe("scripted");
    expect(await response.text()).toContain("event: gate");
  });

  it("still rejects an empty array and a trailing assistant turn", async () => {
    expect((await post({ messages: [] })).status).toBe(400);
    expect(
      (await post({ messages: [{ role: "student", text: "hi" }, { role: "assistant", text: "hello" }] }))
        .status,
    ).toBe(400);
  });
});
