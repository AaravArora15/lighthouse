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
 */

import { useEffect, useRef, useState } from "react";

import { CrisisBanner } from "@/components/crisis-banner";
import * as config from "@/lib/config";

type Message = { role: "student" | "assistant"; text: string };

const OPENING: Message = {
  role: "assistant",
  text: "Hi. This is a safe place to say what's going on. Nobody here knows who you are, and you can stop whenever you want. What's been happening?",
};

export default function StudentChat() {
  const [messages, setMessages] = useState<Message[]>([OPENING]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [crisis, setCrisis] = useState<readonly config.CrisisResource[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, crisis]);

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
        body: JSON.stringify({ messages: history }),
      });
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

          if (event === "gate" && data.showCrisis) {
            // Latch. Never cleared for the life of the session.
            setCrisis(data.resources);
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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="shrink-0">
        <h1 className="text-lg font-semibold tracking-tight">Lighthouse</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Anonymous. A school counsellor reads this afterwards if it looks like you need
          one. Chats that aren&rsquo;t escalated are deleted after{" "}
          {config.RETENTION_DAYS_NON_ESCALATED} days.
        </p>
      </header>

      {/* Above the transcript, always, once shown. */}
      {crisis.length > 0 && <CrisisBanner resources={crisis} />}

      <div className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === "student" ? "flex justify-end" : "flex justify-start"}
          >
            <p
              className={
                m.role === "student"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-sky-600 px-4 py-2.5 text-white"
                  : "max-w-[85%] rounded-2xl rounded-bl-sm bg-stone-100 px-4 py-2.5 text-stone-900 dark:bg-stone-800 dark:text-stone-100"
              }
            >
              {m.text || (sending ? <span className="opacity-50">…</span> : null)}
            </p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {notice && (
        <p className="shrink-0 text-xs text-stone-500 dark:text-stone-400">{notice}</p>
      )}

      <form
        className="flex shrink-0 items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="draft" className="sr-only">
          Your message
        </label>
        <textarea
          id="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. Phone keyboards send.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={config.MAX_TURN_CHARS}
          placeholder="Type whatever you want to say…"
          className="min-h-[3rem] flex-1 resize-none rounded-2xl border border-stone-300 bg-white px-4 py-2.5 text-stone-900 placeholder:text-stone-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="rounded-2xl bg-sky-600 px-5 py-3 font-medium text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </form>

      <p className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
        Lighthouse listens and passes what you say to a counsellor. It is not therapy and
        not an emergency service. If someone is in danger right now, call 995.
      </p>
    </main>
  );
}
