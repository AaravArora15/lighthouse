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
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import * as config from "@/lib/config";
import type { OverrideRecord } from "@/lib/store";
import { TIER_ORDER, TIERS, Tier } from "@/lib/taxonomy";

export function OverridePanel({
  caseId,
  predictedTier,
  existing,
  persisted,
}: {
  caseId: string;
  predictedTier: Tier;
  existing: OverrideRecord | null;
  /** False when the app is running on the in-memory store. Said out loud below. */
  persisted: boolean;
}) {
  const router = useRouter();
  const [tier, setTier] = useState<Tier>(existing?.requestedTier ?? predictedTier);
  const [reason, setReason] = useState(existing?.reason ?? "");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OverrideRecord | null>(existing);
  const [error, setError] = useState<string | null>(null);

  const min = config.REASON_CHARS.override;
  const unchanged = tier === predictedTier;
  const canSubmit = reason.trim().length >= min && !unchanged && !saving;

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

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        {TIER_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTier(t)}
            aria-pressed={tier === t}
            title={TIERS[t].meaning}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              tier === t
                ? "border-sky-600 bg-sky-600 text-white"
                : "border-stone-300 hover:border-stone-400 dark:border-stone-700 dark:hover:border-stone-600"
            }`}
          >
            {t}
            {t === predictedTier && (
              <span className="ml-1 text-xs opacity-70">(model)</span>
            )}
          </button>
        ))}
      </div>

      <label htmlFor="reason" className="mt-3 block text-sm font-medium">
        Why?{" "}
        <span className="font-normal text-stone-500">(required, {min}+ characters)</span>
      </label>
      <textarea
        id="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="What does the model not know about this student?"
        className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm placeholder:text-stone-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 dark:border-stone-700 dark:bg-stone-900"
      />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="mt-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Recording…" : "Record override"}
      </button>
      {unchanged && (
        <span className="ml-3 text-xs text-stone-500 dark:text-stone-400">
          Pick a different tier to record a change.
        </span>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-900">
          <p>
            Recorded <strong>{result.effectiveTier}</strong> over the model&rsquo;s{" "}
            {result.predictedTier}, {new Date(result.at).toLocaleString()}.
          </p>
          {/* The gate refused the change. Do not soften this. */}
          {result.flooredNotice && (
            <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
              {result.flooredNotice}
            </p>
          )}
          {!persisted && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              No DATABASE_URL is set, so this is held in memory and will not survive a
              restart. Said plainly rather than left to be discovered.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
