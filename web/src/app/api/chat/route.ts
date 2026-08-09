/**
 * The chat intake route. This is where the project's central ordering rule is enforced.
 *
 * The safety gate runs **before** the conversational model, and the crisis event is
 * written to the wire before the model is even called. That is not an implementation
 * detail, it is the non-negotiable from CLAUDE.md rendered as control flow:
 *
 *     gate (123 µs, regex)  ->  crisis event flushed  ->  model called  ->  text streamed
 *
 * Read the order in `POST` below. The `crisis` event cannot be delayed, blocked, or
 * cancelled by anything the model does, because at the moment it is enqueued the model
 * has not been contacted. An outage, a timeout, a refusal, or a thrown exception in the
 * intake call all happen strictly after the student already has real phone numbers on
 * screen.
 *
 * The response is SSE rather than a plain streamed body because the client has to
 * distinguish three kinds of thing arriving on one connection: the gate verdict, the
 * assistant's words, and the degradation notice. A bare text stream would force the
 * client to parse sentinels out of prose the model wrote.
 */

import * as config from "@/lib/config";
import { evaluateConversation, evaluateTurn, requiresCrisisResources } from "@/lib/gate/safety";
import { generateReply, hasApiKey, type IntakeMessage } from "@/lib/intake";

export const runtime = "nodejs";
/** The gate must run per request; a cached response would serve one student another's verdict. */
export const dynamic = "force-dynamic";

interface ChatRequest {
  handle?: unknown;
  messages?: unknown;
}

function parseMessages(raw: unknown): IntakeMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: IntakeMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { role, text } = item as Record<string, unknown>;
    if (role !== "student" && role !== "assistant") return null;
    if (typeof text !== "string") return null;
    // Truncate rather than reject: a student who pastes an essay should be listened to,
    // not shown a validation error.
    out.push({ role, text: text.slice(0, config.MAX_TURN_CHARS) });
  }
  return out.at(-1)?.role === "student" ? out : null;
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }

  const messages = parseMessages(body.messages);
  if (!messages) {
    return Response.json(
      { error: "messages must be a non-empty array ending in a student turn" },
      { status: 400 },
    );
  }

  const studentTurns = messages.filter((m) => m.role === "student").map((m) => m.text);
  const latest = studentTurns.at(-1)!;

  // ---- 1. THE GATE. Before anything else, and it cannot fail. ------------------------
  //
  // Two evaluations, because they answer different questions. The per-turn verdict is
  // what this message alone says. The conversation verdict is what the whole transcript
  // says, and it is the one that drives the crisis banner: a weapon in turn 2 plus "after
  // school" in turn 9 is imminent danger, and no single turn holds both.
  const turnVerdict = evaluateTurn(latest, studentTurns.length - 1);
  const conversationVerdict = evaluateConversation(studentTurns);
  const showCrisis = requiresCrisisResources(conversationVerdict);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // ---- 2. Crisis resources, on the wire, now. ---------------------------------
      //
      // Enqueued before the first `await` in this function. Nothing downstream can
      // prevent it from reaching the student.
      send("gate", {
        showCrisis,
        resources: showCrisis ? config.CRISIS_RESOURCES : [],
        // The gate's own reasoning, for the counsellor console later. Never rendered to
        // the student: telling a child which regex matched them is not listening.
        floor: conversationVerdict.floor,
        level: conversationVerdict.level,
        indicators: conversationVerdict.indicators.map((h) => h.category),
        turnLevel: turnVerdict.level,
      });

      // ---- 3. Only now, the model. ------------------------------------------------
      let degraded: string | null = null;
      try {
        const result = await generateReply(messages, (chunk) => send("text", { chunk }));
        degraded = result.degraded;
      } catch (error) {
        // generateReply is contracted never to throw. If it does, the student still gets
        // a reply, because a silent bubble in this product is the failure that matters.
        console.error("[chat] unexpected intake failure:", error);
        send("text", { chunk: "I'm still here. Tell me more whenever you're ready." });
        degraded = "error";
      }

      send("done", {
        degraded,
        // Surfaced in the UI as a quiet line, per context.md §9: the demo says so rather
        // than pretending the model answered.
        degradedNotice: degraded ? degradationNotice(degraded) : null,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell the client whether this deployment has a key at all, so it can render the
      // synthetic-demo banner without a second round trip.
      "X-Lighthouse-Intake": hasApiKey() ? "model" : "scripted",
    },
  });
}

function degradationNotice(reason: string): string {
  switch (reason) {
    case "no_api_key":
      return "Running without the language model. Replies are scripted; safety checks and crisis resources are fully live.";
    case "timeout":
      return "The language model timed out. Your message was still received and checked.";
    case "refusal":
    case "error":
    default:
      return "The language model is unavailable right now. Your message was still received and checked.";
  }
}
