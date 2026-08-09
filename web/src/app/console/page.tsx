/**
 * The counsellor queue.
 *
 * One screen, sorted, scannable. A school counsellor has minutes, not an afternoon, and
 * `config.COUNSELLOR_WEEKLY_BUDGET` says they get through about 20 cases a week — so the
 * design question is not "what can we show" but "what earns a row".
 *
 * The order is `queueRank` (`floor_rank + escalation`), which is the product's ranking
 * rather than the model's. See `lib/cards.ts:queue`.
 */

import Link from "next/link";

import { requireCounsellor } from "@/lib/auth/current";
import { unreviewed } from "@/lib/breakglass";
import { queue, queueStats } from "@/lib/cards";
import { allAlerts } from "@/lib/patterns";
import { ConsoleHeader } from "@/components/console-header";
import { PatternAlertPanel } from "@/components/pattern-alert";
import * as config from "@/lib/config";
import { store } from "@/lib/store";
import { TierBadge } from "@/components/tier-badge";
import { Tier, TIERS } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  // First line of the page, and of every protected page. Next's own guidance is that a
  // proxy/middleware check is an optimistic redirect and not the authorisation, and a
  // layout does not re-render on navigation between its children — so the check lives
  // here, and returns the principal the page then needs rather than a boolean it could
  // forget to read.
  const principal = await requireCounsellor("/console");

  const cases = queue();
  const stats = queueStats();
  const alerts = allAlerts();
  const budget = config.COUNSELLOR_WEEKLY_BUDGET;
  const openGlass = await unreviewed(await store());

  return (
    <main id="content" className="mx-auto w-full max-w-5xl px-4 py-8">
      <ConsoleHeader principal={principal} />

      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Counsellor queue</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          {stats.queued} cases need action, of {stats.total} conversations.{" "}
          {stats.byTier[Tier.T0] + stats.byTier[Tier.T1]} were logged with no action needed
          and are not shown.
        </p>
        {stats.breakGlass > 0 && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-100"
          >
            {stats.breakGlass} case{stats.breakGlass === 1 ? "" : "s"} at T4 — immediate,
            break-glass now. Crisis resources were already shown to the student.
          </p>
        )}

        {/* The one control on break-glass is that these are visible and counted. Shown to
            everyone, not just leads: a counsellor seeing their own unreviewed closure sit
            here for a week is the feedback that keeps the threshold meaningful. */}
        {openGlass.length > 0 && (
          <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
            {openGlass.length} break-glass closure{openGlass.length === 1 ? "" : "s"}{" "}
            awaiting review by a safeguarding lead
            {principal.role === "lead" ? " — that is you." : "."}{" "}
            {openGlass.map((r) => r.caseId).join(", ")}
          </p>
        )}
      </header>

      <PatternAlertPanel alerts={alerts} />

      <ol className="space-y-2">
        {cases.map((card, i) => (
          <li key={card.caseId}>
            {/* The budget line: everything below it is unlikely to be seen this week.
                Drawn rather than hidden, because a counsellor should know the cut exists
                and be able to look past it. recall@budget is measured against this. */}
            {i === budget && (
              <p className="my-4 border-t border-dashed border-stone-300 pt-3 text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">
                Below this line is beyond a typical week of {budget} cases. Measured
                recall of T3 and T4 above the line is{" "}
                <strong>0.865 ±0.019</strong> against a 0.90 target — see docs/results.md.
              </p>
            )}
            <Link
              href={`/console/${card.caseId}`}
              className="flex items-start gap-4 rounded-xl border border-stone-200 bg-white p-4 transition-colors hover:border-stone-300 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700 dark:hover:bg-stone-800/60"
            >
              <TierBadge tier={card.tier} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{card.handle}</span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {card.caseId} · {card.nStudentTurns} messages
                  </span>
                </div>

                {/* The lead reason, not a summary. Deterministic, from the closed bank. */}
                <p className="mt-1 truncate text-sm text-stone-700 dark:text-stone-300">
                  {card.reasons[1] ?? card.reasons[0]}
                </p>

                {card.citedQuotes[0] && (
                  <p className="mt-1 truncate text-sm italic text-stone-500 dark:text-stone-400">
                    &ldquo;{card.citedQuotes[0].text}&rdquo;
                  </p>
                )}
              </div>

              <div className="shrink-0 text-right text-xs text-stone-500 dark:text-stone-400">
                <div className="font-medium text-stone-700 dark:text-stone-300">
                  {TIERS[card.tier].slaHours === 0
                    ? "now"
                    : `${TIERS[card.tier].slaHours}h`}
                </div>
                <div>conf {card.confidence.toFixed(2)}</div>
                {card.tierFloorReason && (
                  <div className="mt-1 font-medium text-amber-700 dark:text-amber-400">
                    gate
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ol>

      <p className="mt-8 text-xs text-stone-500 dark:text-stone-400">
        Every conversation here is synthetic and hand-authored. No real student wrote any
        of it.
      </p>
    </main>
  );
}
