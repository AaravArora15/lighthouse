"use client";

/**
 * The tier override control.
 *
 * Two properties make this worth building rather than stubbing:
 *
 * 1. **The reason is required.** The button stays disabled without one. An override with
 *    no reason is an opinion; with one it is the only ground-truth label this system ever
 *    gets from someone who knows the student, and day 4 established the corpus is 80 rows.
 * 2. **It can be refused, and says so.** A gate floor is re-applied to the counsellor's
 *    choice exactly as it is to the model's. Lowering a T4 self-harm disclosure to T1 is
 *    recorded, and the case stays T4. The UI shows that plainly rather than silently
 *    accepting the click, because a control that pretends to work is worse than one that
 *    explains why it did not.
 *
 * The tiers are a segmented control rather than five loose buttons: they are one choice
 * with five values, and the model's own answer is marked inside it so a counsellor can
 * always see what they are disagreeing with.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import * as config from "@/lib/config";
import type { OverrideRecord } from "@/lib/store";
import { READ_FIRST_REFUSAL } from "@/lib/transcript";
import { TIER_ORDER, TIERS, Tier } from "@/lib/taxonomy";

export function OverridePanel({
  caseId,
  predictedTier,
  existing,
  persisted,
  transcriptRead,
}: {
  caseId: string;
  predictedTier: Tier;
  existing: OverrideRecord | null;
  /** False when the app is running on the in-memory store. Said out loud below. */
  persisted: boolean;
  /**
   * Whether this counsellor has opened the transcript on this case.
   *
   * Presentation only. `recordOverride` re-checks it against the audit log, so a client
   * that ignores this prop gets a 400 rather than a write. The rule lives in one place
   * and this is the courtesy of not letting someone type a paragraph into a control that
   * was going to refuse them.
   */
  transcriptRead: boolean;
}) {
  const router = useRouter();
  const [tier, setTier] = useState<Tier>(existing?.requestedTier ?? predictedTier);
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OverrideRecord | null>(existing);
  const [error, setError] = useState<string | null>(null);

  const min = config.REASON_CHARS.override;
  const unchanged = tier === predictedTier;
  const canSubmit = reason.trim().length >= min && !unchanged && !saving && transcriptRead;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/console/${caseId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedTier: tier, reason: reason.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "could not record the override");
      setResult(data.override as OverrideRecord);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not record the override");
    } finally {
      setSaving(false);
    }
  }

  if (!transcriptRead) {
    return (
      <div className="mt-4 rounded-xl border border-dashed border-line-strong bg-sunk/50 px-4 py-3.5">
        <p className="text-sm leading-relaxed text-muted">{READ_FIRST_REFUSAL}</p>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-sunk p-1">
        {TIER_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTier(t)}
            aria-pressed={tier === t}
            title={TIERS[t].meaning}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              tier === t
                ? "bg-accent text-on-accent shadow-soft"
                : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            {t}
            {t === predictedTier && (
              <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide opacity-70">
                model
              </span>
            )}
          </button>
        ))}
      </div>

      <label htmlFor="reason" className="mt-4 block text-sm font-medium">
        Why?{" "}
        <span className="font-normal text-faint">(required, {min}+ characters)</span>
      </label>
      <textarea
        id="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="What does the model not know about this student?"
        className="mt-1.5 w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-ink transition-colors placeholder:text-faint focus:border-accent-line focus:outline-none"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-sunk disabled:text-faint"
        >
          {saving ? "Recording…" : "Record override"}
        </button>
        {unchanged && (
          <span className="text-xs text-faint">
            Pick a different tier to record a change.
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-line bg-sunk p-4 text-sm leading-relaxed">
          <p>
            Recorded <strong className="font-semibold">{result.effectiveTier}</strong> over
            the model&rsquo;s {result.predictedTier},{" "}
            {new Date(result.at).toLocaleString()}.
          </p>
          {/* The gate refused the change. Do not soften this. */}
          {result.flooredNotice && (
            <p className="mt-2.5 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-warn-ink">
              {result.flooredNotice}
            </p>
          )}
          {!persisted && (
            <p className="mt-2.5 text-xs text-warn">
              No DATABASE_URL is set, so this is held in memory and will not survive a
              restart. Said plainly rather than left to be discovered.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
