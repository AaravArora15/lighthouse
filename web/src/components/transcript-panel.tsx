"use client";

/**
 * The full redacted transcript, behind a logged reason.
 *
 * Level 2 of the three in `docs/context.md` §11, and a **precondition** for the two
 * controls below it rather than an optional extra. The reasoning is in `lib/transcript.ts`
 * and locked in §17: the card is assembled from evidence that agrees with its tier, so it
 * can confirm a tier and never refute one.
 *
 * ## Why it does not open by default
 *
 * It would cost nothing technically — the page already holds a store handle. But then
 * every case a counsellor glanced at would write "Read the full conversation" to a record
 * a student reads, and a log where every line is present is a log that says nothing. The
 * friction is one sentence; what it buys is that the entry means something when it appears.
 *
 * ## Why it stays open after unlocking the controls below
 *
 * `router.refresh()` re-renders the server components so the override panel sees the new
 * audit row, and React preserves this component's state across it. A counsellor writes
 * their override reason with the conversation still in front of them, which is the entire
 * point of the ordering.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import * as config from "@/lib/config";
import type { TranscriptTurn } from "@/lib/transcript";

export function TranscriptPanel({
  caseId,
  alreadyRead,
}: {
  caseId: string;
  /** True when this counsellor has an earlier `viewed_transcript` row on this case. */
  alreadyRead: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [turns, setTurns] = useState<TranscriptTurn[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const min = config.REASON_CHARS.transcript;
  const remaining = Math.max(0, min - reason.trim().length);
  const canSubmit = remaining === 0 && !loading;

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/console/${caseId}/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "could not open the transcript");
      setTurns(data.turns as TranscriptTurn[]);
      setOpen(false);
      // Re-renders the server components so the controls below see the new audit row.
      // This component's state, including the turns just fetched, survives it.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not open the transcript");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-4">
      {turns === null ? (
        !open ? (
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="text-sm leading-relaxed text-muted">
              {alreadyRead
                ? "You have opened this conversation before. Opening it again is recorded again."
                : "The card above shows the evidence that produced the tier. The conversation shows everything else."}
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-3 rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-sunk"
            >
              Open the full conversation…
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-surface p-4">
            <label htmlFor="transcript-reason" className="block text-sm font-medium">
              Why do you need to read it?
            </label>
            <p className="mt-1 text-xs leading-relaxed text-faint">
              Recorded against your name, and the student can read it on their own page.
            </p>
            <textarea
              id="transcript-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Checking whether the flagged message means what the gate thinks it means."
              className="mt-2 w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-ink transition-colors placeholder:text-faint focus:border-accent-line focus:outline-none"
            />
            <p aria-live="polite" className="mt-1.5 text-xs text-muted">
              {remaining > 0
                ? `${remaining} more character${remaining === 1 ? "" : "s"} needed.`
                : "Long enough."}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-sunk disabled:text-faint"
              >
                {loading ? "Opening…" : "Open and record"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm font-medium text-muted underline underline-offset-4 hover:text-ink"
              >
                Cancel
              </button>
            </div>

            {error && (
              <p role="alert" className="mt-2.5 text-sm font-medium text-danger">
                {error}
              </p>
            )}
          </div>
        )
      ) : turns.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          No stored turns for this case. The retention job erases conversation content while
          keeping the case and its access log, so this is what a deleted conversation looks
          like rather than an error.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <p className="border-b border-line bg-sunk px-4 py-2 text-xs text-muted">
            Redacted. Identifying details were removed before storage and there is no raw
            copy. {turns.length} messages.
          </p>
          <ol className="divide-y divide-line">
            {turns.map((turn) => (
              <li key={turn.ordinal} className="flex gap-3 px-4 py-3">
                <span
                  className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    turn.role === "student"
                      ? "bg-accent-soft text-accent-text"
                      : "bg-sunk text-faint"
                  }`}
                >
                  {turn.role === "student" ? "student" : "lighthouse"}
                </span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed">
                  {turn.text}
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
