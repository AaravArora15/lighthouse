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
          className="rounded-2xl border border-insight-line bg-insight-soft p-4"
        >
          <div className="flex items-start gap-2.5">
            <span
              aria-hidden
              className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-insight/15 text-insight"
            >
              {/* Three points and the links between them. The panel's whole claim in
                  one glyph: separate reports that turn out to touch. Drawn at 16 units
                  across a 24 box so the nodes stay distinct at 14px. */}
              <svg viewBox="0 0 24 24" fill="none" className="size-4">
                <path
                  d="M8 7.5 16 12M8 16.5 16 12"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <circle cx="7" cy="7" r="2.8" fill="currentColor" />
                <circle cx="7" cy="17" r="2.8" fill="currentColor" />
                <circle cx="17" cy="12" r="2.8" fill="currentColor" />
              </svg>
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold leading-6 text-insight-ink">
                Possible pattern: {alert.headline}
              </h2>
              <p className="mt-0.5 text-sm leading-relaxed text-muted">
                These students contacted us separately and do not appear to know each other.
                No single conversation showed this.
              </p>
            </div>
          </div>

          <ul className="mt-3.5 flex flex-wrap gap-2">
            {alert.caseIds.map((id, i) => (
              <li key={id}>
                <Link
                  href={`/console/${id}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm transition-colors hover:border-insight-line hover:bg-insight-soft"
                >
                  <span className="font-mono text-xs font-medium">{id}</span>
                  <span className="text-xs font-semibold text-faint">{alert.tiers[i]}</span>
                  {/* The case the classifier dismissed. Worth pointing at: it is the
                      reason this panel exists rather than being a nicety. */}
                  {(alert.tiers[i] === Tier.T0 || alert.tiers[i] === Tier.T1) && (
                    <span
                      title="Scored as no-action on its own. Surfaced only by the pattern."
                      className="rounded-md border border-warn-line bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn-ink"
                    >
                      missed alone
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <details className="group mt-3.5">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-ink">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="size-3 transition-transform group-open:rotate-90"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              Why these were linked
            </summary>
            <ul className="mt-2 space-y-1 pl-[1.125rem]">
              {alert.links.map((l, i) => (
                <li key={i} className="text-xs leading-relaxed text-muted">
                  <span className="font-mono">{l.a}</span> and{" "}
                  <span className="font-mono">{l.b}</span>: {l.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 pl-[1.125rem] text-xs leading-relaxed text-faint">
              Matched on pseudonymous identifiers. Names are not stored and cannot be
              recovered from this alert.
            </p>
          </details>
        </div>
      ))}
    </section>
  );
}
