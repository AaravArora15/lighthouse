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
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import * as config from "@/lib/config";
import type { BreakGlassRecord } from "@/lib/store";
import { TIER_ORDER, Tier, tierRank } from "@/lib/taxonomy";

export function BreakGlassPanel({
  caseId,
  gateFloor,
  existing,
  viewer,
}: {
  caseId: string;
  gateFloor: Tier;
  existing: BreakGlassRecord[];
  /** Who is looking. Decides whether the review control is offered at all. */
  viewer: { counsellorId: string; role: "counsellor" | "lead" };
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
    <div className="mt-8 rounded-xl border border-red-300 bg-red-50/50 p-4 dark:border-red-500/30 dark:bg-red-950/20">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-red-900 dark:text-red-200">
        Break glass
      </h2>
      <p className="mt-1 text-sm text-red-900/90 dark:text-red-100/80">
        The safety gate floors this case at <strong>{gateFloor}</strong> and an override
        cannot go below that. If the gate is wrong about this conversation, you can close
        it anyway. A safeguarding lead reviews every one of these.
      </p>

      {existing.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {existing.map((record) => (
            <li
              key={record.id}
              className="rounded-lg border border-red-200 bg-white px-3 py-2 dark:border-red-500/20 dark:bg-stone-900"
            >
              <p>
                Closed at <strong>{record.closedAtTier}</strong> against a{" "}
                {record.gateFloor} floor by {record.counsellorEmail},{" "}
                {new Date(record.at).toLocaleString()}.
              </p>
              <p className="mt-1 italic text-stone-600 dark:text-stone-400">
                &ldquo;{record.reason}&rdquo;
              </p>
              <p className="mt-1 text-xs font-medium">
                {record.reviewedAt ? (
                  <span className="text-stone-600 dark:text-stone-400">
                    Reviewed {new Date(record.reviewedAt).toLocaleDateString()}
                    {record.reviewNote ? `: ${record.reviewNote}` : ""}
                  </span>
                ) : (
                  <span className="text-red-800 dark:text-red-300">
                    Awaiting review by a safeguarding lead.
                  </span>
                )}
              </p>

              {/* Offered only where it would work. A greyed control with a reason beats
                  one that fails on click, and a counsellor who is not a lead should not
                  have to discover that by trying. */}
              {!record.reviewedAt && viewer.role === "lead" && (
                record.counsellorId === viewer.counsellorId ? (
                  <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
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

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-lg border border-red-400 px-3 py-1.5 text-sm font-medium text-red-900 hover:bg-red-100 dark:border-red-500/40 dark:text-red-200 dark:hover:bg-red-950/50"
        >
          Close this case below the floor…
        </button>
      ) : (
        <div className="mt-4">
          <fieldset>
            <legend className="text-sm font-medium">Close at</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {belowFloor(gateFloor).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  aria-pressed={tier === t}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                    tier === t
                      ? "border-red-600 bg-red-600 text-white"
                      : "border-stone-300 hover:border-stone-400 dark:border-stone-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="bg-reason" className="mt-3 block text-sm font-medium">
            What makes you certain the gate is wrong here?
          </label>
          <textarea
            id="bg-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="A lead will read this weeks from now with no memory of the case."
            className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm placeholder:text-stone-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30 dark:border-stone-700 dark:bg-stone-900"
          />
          <p aria-live="polite" className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {remaining > 0
              ? `${remaining} more character${remaining === 1 ? "" : "s"} needed.`
              : "Long enough."}
          </p>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Recording…" : `Break glass and close at ${tier}`}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm underline underline-offset-4"
            >
              Cancel
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-red-900/70 dark:text-red-100/60">
        This does not undo anything the student saw. If crisis resources were shown during
        the conversation, they were shown.
      </p>
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
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label htmlFor={`review-${id}`} className="sr-only">
        Review note
      </label>
      <input
        id={`review-${id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Agree or disagree, and why"
        className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm placeholder:text-stone-400 dark:border-stone-700 dark:bg-stone-900"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={note.trim().length < min || saving}
        className="rounded-lg border border-stone-400 px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-600"
      >
        {saving ? "Recording…" : "Record review"}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
