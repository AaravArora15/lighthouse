"use client";

/**
 * The break-glass control.
 *
 * Three deliberate pieces of friction, in order:
 *
 * 1. **It is closed by default.** A button that reads "Break glass" sitting open next to
 *    the override control would get clicked by someone reaching for the override.
 * 2. **The consequence is stated before the field, not after.** By the time a counsellor
 *    is typing the reason they should already know a lead will read it.
 * 3. **The reason bar is long and the counter is live.** `REASON_CHARS.breakGlass` is 40
 *    characters — enough that "false positive" does not clear it, which is the whole point.
 *
 * What it is *not* is hidden or hard to find. The escape hatch has to be obviously there,
 * or a counsellor facing a false T4 works around the system instead of through it, and
 * then there is no record at all.
 *
 * It is the only panel in the console drawn in `danger`, and the only one with a hairline
 * rule down its left edge. Both are there so it cannot be mistaken for the override
 * control sitting immediately above it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import * as config from "@/lib/config";
import type { BreakGlassRecord } from "@/lib/store";
import { READ_FIRST_REFUSAL } from "@/lib/transcript";
import { TIER_ORDER, Tier, tierRank } from "@/lib/taxonomy";

export function BreakGlassPanel({
  caseId,
  gateFloor,
  existing,
  viewer,
  transcriptRead,
}: {
  caseId: string;
  gateFloor: Tier;
  existing: BreakGlassRecord[];
  /** Who is looking. Decides whether the review control is offered at all. */
  viewer: { counsellorId: string; role: "counsellor" | "lead" };
  /**
   * Whether this counsellor has opened the transcript on this case. Presentation only;
   * `breakGlass()` re-checks it against the audit log. Reviewing an existing closure is
   * deliberately NOT gated on it: a review judges the reason its author wrote, which
   * `REASON_CHARS.breakGlass` is set at 40 characters to make self-contained.
   */
  transcriptRead: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [tier, setTier] = useState<Tier>(() => belowFloor(gateFloor)[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const min = config.REASON_CHARS.breakGlass;
  const remaining = Math.max(0, min - reason.trim().length);
  const canSubmit = remaining === 0 && !saving;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/console/${caseId}/break-glass`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closedAtTier: tier, reason: reason.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "could not record this");
      setReason("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not record this");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-8 overflow-hidden rounded-2xl border border-danger-line bg-danger-soft">
      <div className="border-l-[3px] border-danger p-5">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-danger">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="size-3.5"
          >
            <path d="M12 3 3 19h18L12 3ZM12 10v4M12 17v.01" />
          </svg>
          Break glass
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-danger-ink">
          The safety gate floors this case at{" "}
          <strong className="font-semibold">{gateFloor}</strong> and an override cannot go
          below that. If the gate is wrong about this conversation, you can close it
          anyway. A safeguarding lead reviews every one of these.
        </p>

        {existing.length > 0 && (
          <ul className="mt-4 space-y-2.5">
            {existing.map((record) => (
              <li
                key={record.id}
                className="rounded-xl border border-danger-line/70 bg-surface px-4 py-3 text-sm leading-relaxed"
              >
                <p>
                  Closed at{" "}
                  <strong className="font-semibold">{record.closedAtTier}</strong> against a{" "}
                  {record.gateFloor} floor by {record.counsellorEmail},{" "}
                  {new Date(record.at).toLocaleString()}.
                </p>
                <p className="mt-1.5 italic text-muted">&ldquo;{record.reason}&rdquo;</p>
                <p className="mt-2 text-xs font-medium">
                  {record.reviewedAt ? (
                    <span className="text-muted">
                      Reviewed {new Date(record.reviewedAt).toLocaleDateString()}
                      {record.reviewNote ? `: ${record.reviewNote}` : ""}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-danger-soft px-2 py-1 text-danger">
                      <span aria-hidden className="size-1.5 rounded-full bg-danger" />
                      Awaiting review by a safeguarding lead.
                    </span>
                  )}
                </p>

                {/* Offered only where it would work. A greyed control with a reason beats
                    one that fails on click, and a counsellor who is not a lead should not
                    have to discover that by trying. */}
                {!record.reviewedAt && viewer.role === "lead" && (
                  record.counsellorId === viewer.counsellorId ? (
                    <p className="mt-2.5 text-xs text-faint">
                      This is your own closure. Another lead has to sign it off.
                    </p>
                  ) : (
                    <ReviewControl id={record.id} />
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {!transcriptRead ? (
          <p className="mt-4 rounded-xl border border-dashed border-danger-line bg-surface/60 px-4 py-3 text-sm leading-relaxed text-danger-ink">
            {READ_FIRST_REFUSAL}
          </p>
        ) : !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-4 rounded-xl border border-danger-line bg-surface px-3.5 py-2 text-sm font-semibold text-danger transition-colors hover:border-danger hover:bg-danger-soft"
          >
            Close this case below the floor…
          </button>
        ) : (
          <div className="mt-4">
            <fieldset>
              <legend className="text-sm font-medium">Close at</legend>
              <div className="mt-1.5 inline-flex flex-wrap gap-1 rounded-xl border border-danger-line/70 bg-surface p-1">
                {belowFloor(gateFloor).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTier(t)}
                    aria-pressed={tier === t}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                      tier === t
                        ? "bg-danger text-danger-soft"
                        : "text-muted hover:bg-danger-soft hover:text-danger"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </fieldset>

            <label htmlFor="bg-reason" className="mt-4 block text-sm font-medium">
              What makes you certain the gate is wrong here?
            </label>
            <textarea
              id="bg-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="A lead will read this weeks from now with no memory of the case."
              className="mt-1.5 w-full resize-y rounded-xl border border-danger-line/70 bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-ink transition-colors placeholder:text-faint focus:border-danger focus:outline-none"
            />

            {/* The counter is the friction. `aria-live` so it is friction for a screen
                reader too, rather than a silently disabled button. */}
            <div className="mt-2">
              <div
                aria-hidden
                className="h-1 w-full overflow-hidden rounded-full bg-danger-line/50"
              >
                <div
                  className="h-full rounded-full bg-danger transition-[width] duration-200"
                  style={{
                    width: `${Math.min(100, (reason.trim().length / min) * 100)}%`,
                  }}
                />
              </div>
              <p aria-live="polite" className="mt-1.5 text-xs text-muted">
                {remaining > 0
                  ? `${remaining} more character${remaining === 1 ? "" : "s"} needed.`
                  : "Long enough."}
              </p>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="rounded-xl bg-danger px-4 py-2 text-sm font-semibold text-danger-soft transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sunk disabled:text-faint"
              >
                {saving ? "Recording…" : `Break glass and close at ${tier}`}
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
        )}

        <p className="mt-5 text-xs leading-relaxed text-muted">
          This does not undo anything the student saw. If crisis resources were shown during
          the conversation, they were shown.
        </p>
      </div>
    </div>
  );
}

/** The tiers a break-glass may close at: strictly below the floor. */
function belowFloor(floor: Tier): Tier[] {
  return TIER_ORDER.filter((t) => tierRank(t) < tierRank(floor));
}

/** The lead's sign-off. Separate component so each record keeps its own note state. */
function ReviewControl({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const min = config.REASON_CHARS.breakGlassReview;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/break-glass/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "could not record the review");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not record the review");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      <label htmlFor={`review-${id}`} className="sr-only">
        Review note
      </label>
      <input
        id={`review-${id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Agree or disagree, and why"
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink transition-colors placeholder:text-faint focus:border-accent-line focus:outline-none"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={note.trim().length < min || saving}
        className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Recording…" : "Record review"}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
