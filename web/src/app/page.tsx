"use client";

/**
 * The student chat.
 *
 * `docs/context.md` §14 names the scope risk on this screen explicitly: two interfaces,
 * and the student-facing one must stay deliberately simple. Warm, calm, few elements.
 * A distressed 13-year-old on a phone is the user. There is no sidebar, no settings, no
 * onboarding carousel, and no branding.
 *
 * Two behaviours here are load-bearing rather than cosmetic:
 *
 * - `showCrisis` is a **latch**. Once the gate floors the conversation at T4 the banner
 *   stays for the rest of the session. A later calm message must not remove crisis
 *   numbers from a student's screen.
 * - The gate event is consumed the instant it arrives, before the first text chunk. The
 *   server writes it first; this renders it first.
 *
 * ## The layout is a fixed shell, not a long page
 *
 * Header, crisis banner, scrolling transcript, docked composer. The page itself never
 * scrolls; only the transcript does. On a phone that means the box you type into is
 * always under your thumb and the crisis numbers never scroll off the top, which is the
 * whole point of having put them there.
 */

import { useEffect, useRef, useState } from "react";

import { CrisisBanner } from "@/components/crisis-banner";
import { LighthouseMark } from "@/components/mark";
import { CONSENT_LINES } from "@/lib/student";
import * as config from "@/lib/config";

type Message = { role: "student" | "assistant"; text: string };

const OPENING: Message = {
  role: "assistant",
  text: "Hi. This is a safe place to say what's going on. Nobody here knows who you are, and you can stop whenever you want. What's been happening?",
};

/** Tallest the composer grows before it scrolls internally, in pixels. */
const COMPOSER_MAX_HEIGHT = 184;

export default function StudentChat() {
  const [messages, setMessages] = useState<Message[]>([OPENING]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [crisis, setCrisis] = useState<readonly config.CrisisResource[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The case this conversation is being written to. Minted by the server on the first
   * message and carried from then on, so every turn lands on one case rather than
   * creating a new one each time.
   *
   * Held in a ref, not state: it is read inside `send` and must be the current value, and
   * putting it in state would give `send` a stale closure on the first follow-up message —
   * which would silently split one conversation into two cases.
   */
  const caseRef = useRef<{ conversationId: string; handle: string; startedAt: string } | null>(null);
  /**
   * The same id, in state, purely so the link to the receipt can render.
   *
   * The ref is the source of truth for *sending*; this mirrors it for *drawing*. Two
   * copies because a ref does not trigger a re-render and state inside `send` would be
   * stale on the first follow-up message, which would silently split one conversation
   * into two cases.
   */
  const [caseId, setCaseId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, crisis]);

  /**
   * Grow the composer with the message, up to a cap.
   *
   * A fixed two-row box makes anyone writing more than a sentence type into a letterbox,
   * and this is a product whose users are trying to explain something complicated. The
   * cap exists so a long message cannot push the transcript off the screen entirely.
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  /**
   * Recover the case reference after a refresh.
   *
   * Only the id, never the messages. Restoring the transcript would mean a shared or
   * borrowed device shows the last person's disclosure to whoever opens the tab next,
   * which on a school laptop is a realistic Tuesday. The id alone lets the student find
   * their receipt again and nothing else.
   */
  useEffect(() => {
    try {
      const saved = localStorage.getItem("lighthouse:case");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.conversationId === "string") {
          caseRef.current = parsed;
          // `localStorage` does not exist during server rendering, so this cannot be a
          // lazy state initialiser: the server would render null, the client would render
          // the id, and that is a hydration mismatch. An effect is the correct place to
          // read a client-only store, and one extra render is the cost of doing it right.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCaseId(parsed.conversationId);
        }
      }
    } catch {
      // A blocked or full localStorage must never stop a student typing.
    }
  }, []);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;

    const history: Message[] = [...messages, { role: "student", text }];
    setMessages([...history, { role: "assistant", text: "" }]);
    setDraft("");
    setSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, ...caseRef.current }),
      });
      // A rejected request still has a body — a JSON error, not an SSE stream. Without
      // this check the frame parser below finds no events, and the student is left with
      // the empty bubble this product treats as the failure that matters.
      if (!response.ok) throw new Error(`chat rejected: ${response.status}`);
      if (!response.body) throw new Error("no stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Keep the trailing partial frame.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const raw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !raw) continue;
          const data = JSON.parse(raw);

          if (event === "gate") {
            // Remember the case on the first reply; the server echoes it every time.
            if (!caseRef.current && data.conversationId) {
              const next = {
                conversationId: data.conversationId,
                handle: data.handle,
                startedAt: data.startedAt,
              };
              caseRef.current = next;
              setCaseId(next.conversationId);
              try {
                localStorage.setItem("lighthouse:case", JSON.stringify(next));
              } catch {
                // Private browsing, or storage full. The session still works; only the
                // ability to find the receipt after a refresh is lost.
              }
            }
            if (data.showCrisis) {
              // Latch. Never cleared for the life of the session.
              setCrisis(data.resources);
            }
          } else if (event === "text") {
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = {
                role: "assistant",
                text: next[next.length - 1].text + data.chunk,
              };
              return next;
            });
          } else if (event === "done") {
            setNotice(data.degradedNotice ?? null);
          }
        }
      }
    } catch {
      // Even a dead network leaves the student with something that acknowledges them.
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          text: "Something went wrong on our side, but what you wrote was received. Tell me more whenever you're ready.",
        };
        return next;
      });
      setNotice("Connection problem. Your messages are still being checked for safety.");
    } finally {
      setSending(false);
    }
  }

  const remaining = config.MAX_TURN_CHARS - draft.length;

  return (
    <main id="content" className="flex h-dvh flex-col overflow-hidden">
      <header className="shrink-0 border-b border-line/80">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2.5 px-4 py-3">
          <LighthouseMark />
          <h1 className="text-[15px] font-semibold tracking-tight">Lighthouse</h1>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            Anonymous
          </span>
        </div>
      </header>

      {/*
        Above the transcript and *outside* the scroll container, always, once shown.
        Previously this sat at the top of the transcript, which meant three more messages
        scrolled the crisis numbers off the screen. A banner CLAUDE.md calls unconditional
        should not be conditional on how far you have scrolled.

        Capped at 42% of the viewport and scrolled internally past that. Always-visible
        and unbounded are in tension on a phone: three resources with their WhatsApp
        alternatives run to roughly 400px, which on a 667px screen would leave a student
        about four lines of conversation. The cap keeps the first number — the one that
        matters most — permanently on screen while guaranteeing the transcript over half
        the display.
      */}
      {crisis.length > 0 && (
        <div className="scroll-quiet mx-auto max-h-[42dvh] w-full max-w-2xl shrink-0 overflow-y-auto px-4 pt-3">
          <CrisisBanner resources={crisis} />
        </div>
      )}

      <div className="scroll-quiet flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-2xl px-4 pb-8 pt-5">
          {/* The consent screen from context.md §11, as two sentences rather than a wall.
              A page of policy at the top of a crisis chat is not consent, it is an obstacle,
              and it gets scrolled past by exactly the people it was meant to protect.
              It scrolls away with the rest of the transcript once the conversation starts,
              which is correct: it is read once. */}
          <section className="rounded-2xl border border-line bg-sunk/60 px-4 py-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
              Before you start
            </h2>
            <div className="mt-1.5 space-y-1 text-[13px] leading-[1.55] text-muted">
              {CONSENT_LINES.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p>
                Chats that nobody needs to follow up are deleted after{" "}
                {config.RETENTION_DAYS_NON_ESCALATED} days.
              </p>
            </div>
          </section>

          {/* The way back. Without this the case id lives only in memory and the student has
              no route to the audit log §11 promises them. */}
          {caseId && (
            <p className="mt-3 rounded-2xl border border-accent-line bg-accent-soft px-4 py-3 text-sm leading-relaxed text-muted">
              You can{" "}
              <a
                href={`/c/${caseId}`}
                className="font-medium text-accent-text underline decoration-accent-line decoration-2 underline-offset-4 hover:decoration-accent-text"
              >
                see what was saved and who has opened it
              </a>
              . Save that link if you want to come back to it later. Anyone who has the link
              can read it, so keep it to yourself.
            </p>
          )}

          <div className="mt-6 space-y-3" aria-live="polite">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`message-in flex ${
                  m.role === "student" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={
                    m.role === "student"
                      ? "max-w-[85%] rounded-3xl rounded-br-lg bg-accent px-4 py-2.5 text-[15px] leading-relaxed text-on-accent shadow-soft"
                      : "max-w-[85%] rounded-3xl rounded-bl-lg bg-sunk px-4 py-2.5 text-[15px] leading-relaxed text-ink"
                  }
                >
                  {/* `whitespace-pre-wrap` because Shift+Enter inserts a newline and the
                      old markup collapsed it, so a student who laid out three separate
                      things carefully saw them run together into one paragraph. */}
                  {m.text ? (
                    <p className="whitespace-pre-wrap">{m.text}</p>
                  ) : sending ? (
                    <TypingDots />
                  ) : null}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-line/80">
        <div className="mx-auto w-full max-w-2xl px-4 pb-4 pt-3">
          {notice && (
            <p className="mb-2 flex items-start gap-2 rounded-xl bg-sunk px-3 py-2 text-xs leading-relaxed text-muted">
              <span aria-hidden className="mt-0.5 text-faint">
                ⓘ
              </span>
              {notice}
            </p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="draft" className="sr-only">
              Your message
            </label>
            {/*
              One composer, not a textarea sitting next to a button. The border and the
              focus ring belong to the whole control, which is what makes it read as a
              single place to write rather than as a form to fill in.
            */}
            <div className="flex items-end gap-2 rounded-[1.75rem] border border-line bg-surface py-1.5 pl-4 pr-1.5 shadow-soft transition-colors focus-within:border-accent-line">
              <textarea
                id="draft"
                ref={composerRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks the line. Phone keyboards send.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                maxLength={config.MAX_TURN_CHARS}
                placeholder="Type whatever you want to say…"
                className="scroll-quiet max-h-[184px] min-h-[2.5rem] flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-ink placeholder:text-faint focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-sunk disabled:text-faint"
              >
                <SendGlyph sending={sending} />
                <span className="sr-only">Send</span>
              </button>
            </div>
          </form>

          {/* Only once it is close enough to matter. A counter that is always on turns
              writing about something difficult into an exam. */}
          {remaining <= config.MAX_TURN_CHARS * 0.15 && (
            <p className="mt-1.5 text-right text-xs tabular-nums text-faint">
              {remaining} characters left
            </p>
          )}

          <p className="mt-2.5 text-center text-xs leading-relaxed text-faint">
            Lighthouse listens and passes what you say to a counsellor. It is not therapy and
            not an emergency service. If someone is in danger right now, call 995.
          </p>
        </div>
      </div>
    </main>
  );
}

/** Three dots while the model is still writing. See `.typing-dot` in globals.css. */
function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-2" role="status" aria-label="Writing a reply">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="typing-dot size-1.5 rounded-full bg-faint"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/** An arrow, or a spinner while a reply is streaming. */
function SendGlyph({ sending }: { sending: boolean }) {
  if (sending) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="size-4.5 animate-spin">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2} opacity={0.3} />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4.5"
    >
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}
