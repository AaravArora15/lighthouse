/**
 * The cross-conversation pattern alert.
 *
 * Deliberately styled as a *notice*, not as an escalation: it sits above the queue in a
 * distinct colour from the T4 break-glass banner, because confusing "look at these
 * together" with "act now" would devalue both.
 *
 * Names are never shown because they are never stored. The alert says "the same person"
 * on the strength of matching HMAC pseudonyms, which is enough for a counsellor to act
 * and not enough for anyone to identify a child from the database.
 */

import Link from "next/link";

import type { PatternAlert } from "@/lib/patterns";
import { Tier } from "@/lib/taxonomy";

export function PatternAlertPanel({ alerts }: { alerts: PatternAlert[] }) {
  if (alerts.length === 0) return null;

  return (
    <section aria-label="Cross-conversation patterns" className="mb-6 space-y-3">
      {alerts.map((alert) => (
        <div
          key={alert.clusterId}
          className="rounded-xl border border-violet-300 bg-violet-50 p-4 dark:border-violet-500/30 dark:bg-violet-950/30"
        >
          <h2 className="text-sm font-semibold text-violet-950 dark:text-violet-100">
            Possible pattern: {alert.headline}
          </h2>
          <p className="mt-1 text-sm text-violet-900/80 dark:text-violet-100/70">
            These students contacted us separately and do not appear to know each other.
            No single conversation showed this.
          </p>

          <ul className="mt-3 flex flex-wrap gap-2">
            {alert.caseIds.map((id, i) => (
              <li key={id}>
                <Link
                  href={`/console/${id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-white px-2.5 py-1 text-sm hover:border-violet-400 dark:border-violet-500/30 dark:bg-stone-900"
                >
                  <span className="font-medium">{id}</span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {alert.tiers[i]}
                  </span>
                  {/* The case the classifier dismissed. Worth pointing at: it is the
                      reason this panel exists rather than being a nicety. */}
                  {(alert.tiers[i] === Tier.T0 || alert.tiers[i] === Tier.T1) && (
                    <span
                      title="Scored as no-action on its own. Surfaced only by the pattern."
                      className="rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
                    >
                      missed alone
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-violet-900/70 dark:text-violet-100/60">
              Why these were linked
            </summary>
            <ul className="mt-2 space-y-1">
              {alert.links.map((l, i) => (
                <li key={i} className="text-xs text-violet-900/70 dark:text-violet-100/60">
                  {l.a} and {l.b}: {l.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-violet-900/60 dark:text-violet-100/50">
              Matched on pseudonymous identifiers. Names are not stored and cannot be
              recovered from this alert.
            </p>
          </details>
        </div>
      ))}
    </section>
  );
}
