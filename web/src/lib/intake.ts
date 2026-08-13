/**
 * The conversational intake model.
 *
 * This module writes the assistant's chat replies and **nothing else**. It never sees a
 * tier, never proposes one, and its output is never read by the classifier. That
 * separation is the project thesis (CLAUDE.md): the classifier decides, the LLM only
 * explains. If you ever find yourself passing a `Tier` into this file, stop.
 *
 * ## Degradation is the design, not a fallback
 *
 * `generateReply` has three outcomes and the caller treats all three the same way:
 * streamed text, or a deterministic scripted reply, or a deterministic scripted reply.
 * There is no error path that produces silence. The safety gate has already run and the
 * crisis banner has already rendered by the time this is called, so a total LLM outage
 * degrades the *warmth* of the conversation and not the *safety* of it.
 *
 * Cases that reach the scripted responder:
 *   - no `ANTHROPIC_API_KEY` (the state this was built in)
 *   - the API is down, rate-limited, or times out
 *   - `stop_reason: "refusal"` — HTTP 200 with empty content
 *
 * That third one is not hypothetical here. This product's entire input distribution is
 * self-harm, abuse and bullying disclosure, which is exactly the content safety
 * classifiers decline. `docs/context.md` §12 flagged it on day 1 as the failure that
 * "would otherwise look like a silent bug". It is handled explicitly, twice: server-side
 * fallbacks re-run a declined request on another model, and if the whole chain declines,
 * the scripted responder answers.
 */

import Anthropic from "@anthropic-ai/sdk";

import * as config from "@/lib/config";

/**
 * The tightest constraint in the product, and deliberately negative.
 *
 * Every line here exists because the alternative is a listening tool that quietly starts
 * practising therapy. The model's job is to keep a frightened 13-year-old typing for
 * another two minutes so the classifier has evidence to work with, and to do nothing else.
 */
const SYSTEM_PROMPT = `You are the listening half of Lighthouse, an anonymous chat service for school students.

Your only job is to listen and to help the student keep talking. A trained school counsellor reads what they write afterwards and decides what happens next. You are not that counsellor and you must never act like one.

What you do:
- Acknowledge what they said, in their own register. Short. Warm. Human.
- Ask one open question that invites detail: what happened, when, how often, who else was there, how long it has been going on.
- Let them set the pace. Silence and short answers are fine.

What you never do:
- Never give advice, strategies, coping techniques, or things to try.
- Never diagnose, interpret, or name what they are feeling for them.
- Never promise confidentiality, outcomes, or that things will be okay.
- Never say you are a counsellor, a therapist, or a professional. If asked what you are, say plainly that you are an automated listening service and a real counsellor reads this afterwards.
- Never ask for their real name, school, address, or the full name of anyone else. If they volunteer one, do not repeat it back.
- Never mention risk levels, tiers, scores, or the fact that anything is being assessed.

Style: two or three sentences at most. No lists. No headings. No emoji. Plain sentences a 12-year-old reads without effort. Do not open with "I'm sorry to hear that" or any stock sympathy phrase.

If the student describes being in danger right now, acknowledge it directly and calmly, and keep listening. Crisis phone numbers are already on their screen; you do not need to repeat them and you must not tell them to go away and call someone instead.

Do not include internal or system XML tags in your response.`;

/**
 * What the student sees when the model is unavailable.
 *
 * Written to be indistinguishable in *function* from a model reply: acknowledge, then ask
 * one open question. It is duller, and that is the whole cost of an API outage here.
 *
 * Indexed by turn count so a student who sends three messages during an outage does not
 * get the same sentence three times, which reads as broken rather than quiet.
 */
const SCRIPTED_REPLIES: readonly string[] = [
  "I'm listening. Can you tell me a bit more about what's been happening?",
  "Thank you for telling me that. How long has this been going on?",
  "That sounds really hard to carry. Who else knows about this, if anyone?",
  "I'm still here. What happened the last time it came up?",
  "Take your time. Is there anything else you want the counsellor to know?",
];

export function scriptedReply(turnIndex: number): string {
  return SCRIPTED_REPLIES[Math.min(turnIndex, SCRIPTED_REPLIES.length - 1)];
}

export type IntakeMessage = { role: "student" | "assistant"; text: string };

export interface ReplyResult {
  /** Why the reply was scripted rather than generated. `null` when the model answered. */
  degraded: null | "no_api_key" | "refusal" | "error" | "timeout";
}

/** Set once. Constructing the client per request would drop connection reuse. */
let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // `maxRetries` is set explicitly because the SDK default of 2 multiplies both the wall
  // clock a student waits and the bill for the calls most likely to time out. See
  // INTAKE_MAX_RETRIES.
  client ??= new Anthropic({ maxRetries: config.INTAKE_MAX_RETRIES });
  return client;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Stream a reply, calling `onText` for each chunk. Resolves with why it degraded, if it did.
 *
 * Never throws and never resolves without having emitted at least one chunk. A caller can
 * pipe `onText` straight to the wire without a null check.
 */
export async function generateReply(
  history: readonly IntakeMessage[],
  onText: (chunk: string) => void,
): Promise<ReplyResult> {
  const turnIndex = history.filter((m) => m.role === "student").length - 1;
  const anthropic = getClient();

  if (!anthropic) {
    onText(scriptedReply(turnIndex));
    return { degraded: "no_api_key" };
  }

  const messages = history.map((m) => ({
    role: m.role === "student" ? ("user" as const) : ("assistant" as const),
    content: m.text,
  }));

  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: config.INTAKE_MODEL,
        max_tokens: config.INTAKE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        // Thinking off, effort low. This is a two-sentence reply to a distressed child
        // waiting on a phone: latency is the quality metric, and there is nothing here
        // to reason about. Disabling thinking is permitted at effort `high` or below.
        // The tool-call-leak failure mode of disabled thinking does not apply because
        // this call defines no tools at all; the XML-tag leak is covered by the last
        // line of the system prompt.
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        // The reason this whole product exists is also the reason the model may decline
        // to answer. Route a declined request to a fallback model rather than showing
        // the student nothing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { timeout: config.CLASSIFIER_TIMEOUT_SECONDS * 1000 },
    );

    let emitted = 0;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emitted += event.delta.text.length;
        onText(event.delta.text);
      }
    }

    const final = await stream.finalMessage();

    // HTTP 200, `content: []`. Without this branch the student watches an empty bubble
    // and concludes the service ignored them at the worst possible moment.
    if (final.stop_reason === "refusal" || emitted === 0) {
      onText(scriptedReply(turnIndex));
      return { degraded: "refusal" };
    }

    return { degraded: null };
  } catch (error) {
    // Deliberately one branch. Rate limit, overload, timeout, network: from the student's
    // side these are the same event, and the response to all of them is to keep the
    // conversation alive. The distinction is logged for us, not surfaced to them.
    const degraded =
      error instanceof Anthropic.APIConnectionTimeoutError ? "timeout" : "error";
    console.error("[intake] model unavailable, falling back to scripted reply:", error);
    onText(scriptedReply(turnIndex));
    return { degraded };
  }
}
