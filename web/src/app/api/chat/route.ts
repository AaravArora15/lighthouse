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
import { scoreConversation } from "@/lib/classifier";
import { newCaseId, newHandle, persistConversation, saveScoredCard } from "@/lib/live";
import { store } from "@/lib/store";

export const runtime = "nodejs";
/** The gate must run per request; a cached response would serve one student another's verdict. */
export const dynamic = "force-dynamic";

interface ChatRequest {
  handle?: unknown;
  startedAt?: unknown;
  messages?: unknown;
  /**
   * Supplied by the client from the second message onward, echoed back on the first.
   *
   * The server mints it; the client only carries it. A client-chosen id would let anyone
   * append turns to a case id they guessed, which on this product means writing into
   * another student's disclosure.
   */
  conversationId?: unknown;
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

  // Case identity. Minted here on the first message of a conversation and carried by the
  // client thereafter; `startedAt` likewise, so a conversation's age is when it began
  // rather than when its last message landed — which is what retention is measured from.
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.startsWith("live-")
      ? body.conversationId
      : newCaseId();
  const handle = typeof body.handle === "string" && body.handle ? body.handle : newHandle();
  const startedAt =
    typeof body.startedAt === "string" && !Number.isNaN(Date.parse(body.startedAt))
      ? body.startedAt
      : new Date().toISOString();

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
        // So the client can carry the case forward, and so a student could in principle
        // be shown "this is your reference" later.
        conversationId,
        handle,
        startedAt,
      });

      // ---- 3. Store the case, BEFORE contacting the model. -------------------------
      //
      // The ordering rule here is the same shape as the crisis one above, for the same
      // reason. The gate is 123 µs of local regex; the model is a network call to
      // something that can hang, refuse, or fall over. **A case that only exists once the
      // model has answered is a case that does not exist during an outage** — and the
      // conversations that most need to survive an outage are exactly the ones the gate
      // has just floored at T4.
      //
      // So the counsellor's copy is written first. It costs a few hundred milliseconds
      // before the reply starts, which is paid after the student already has crisis
      // numbers on screen.
      let persistError: unknown = null;
      try {
        await persistConversation(await store(), {
          caseId: conversationId,
          handle,
          startedAt,
          turns: messages.map((m) => ({ role: m.role, text: m.text })),
          verdict: conversationVerdict,
          crisisResourcesShown: showCrisis,
        });
      } catch (error) {
        // Never fatal to the student's experience. They are mid-disclosure; the reply
        // matters more to them right now than our bookkeeping does. It is logged loudly
        // because a silent failure here means a counsellor never sees the case.
        persistError = error;
        console.error("[chat] FAILED TO PERSIST CASE", conversationId, error);
      }

      // ---- 4. Ask the classifier, concurrently with the model. ---------------------
      //
      // Started here and awaited after the reply has streamed, so the scoring call runs
      // inside the time the language model was going to take anyway and costs the student
      // nothing. It cannot fail loudly: `scoreConversation` returns an outcome, never
      // throws, and a null card just means the gate-only one already stored stands.
      const scoring = scoreConversation({
        caseId: conversationId,
        handle,
        startedAt,
        turns: messages.map((m) => ({ role: m.role, text: m.text })),
      });

      // ---- 5. Only now, the model. ------------------------------------------------
      let degraded: string | null = null;
      let replyText = "";
      try {
        const result = await generateReply(messages, (chunk) => {
          replyText += chunk;
          send("text", { chunk });
        });
        degraded = result.degraded;
      } catch (error) {
        // generateReply is contracted never to throw. If it does, the student still gets
        // a reply, because a silent bubble in this product is the failure that matters.
        console.error("[chat] unexpected intake failure:", error);
        replyText = "I'm still here. Tell me more whenever you're ready.";
        send("text", { chunk: replyText });
        degraded = "error";
      }

      // The assistant's reply is part of the transcript a counsellor reads, so the case is
      // rewritten with it appended. Failure here is not reported to the student either:
      // the student turns, which carry the disclosure, are already stored.
      if (!persistError) {
        try {
          await persistConversation(await store(), {
            caseId: conversationId,
            handle,
            startedAt,
            turns: [...messages, { role: "assistant" as const, text: replyText }].map(
              (m) => ({ role: m.role, text: m.text }),
            ),
            verdict: conversationVerdict,
            crisisResourcesShown: showCrisis,
          });
        } catch (error) {
          console.error("[chat] failed to append the reply to", conversationId, error);
        }
      }

      // ---- 6. Upgrade the card, if the classifier answered in time. ----------------
      const scored = await scoring;
      if (scored.card && !persistError) {
        try {
          await saveScoredCard(await store(), {
            caseId: conversationId,
            handle,
            startedAt,
            card: scored.card,
            verdict: conversationVerdict,
            crisisResourcesShown: showCrisis,
          });
        } catch (error) {
          console.error("[chat] failed to save the scored card for", conversationId, error);
        }
      }
      if (scored.outcome !== "not_configured") {
        console.info(
          `[chat] classifier ${scored.outcome} in ${scored.ms}ms for ${conversationId}`,
        );
      }

      send("done", {
        degraded,
        conversationId,
        // Not rendered to the student. Nothing about how the counsellor's copy was scored
        // belongs on a child's screen mid-disclosure; this is here for the demo and for
        // anyone debugging a deployment.
        classifier: scored.outcome,
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
