/**
 * The counsellor queue.
 *
 * One screen, sorted, scannable. A school counsellor has minutes, not an afternoon, and
 * `config.COUNSELLOR_WEEKLY_BUDGET` says they get through about 20 cases a week — so the
 * design question is not "what can we show" but "what earns a row".
 *
 * The order is `queueRank` (`floor_rank + escalation`), which is the product's ranking
 * rather than the model's. See `lib/cards.ts:queue`.
 *
 * A row therefore carries four things and no more: how urgent, who, why, and in their own
 * words. Everything else — confidence, whether the gate moved it, whether the classifier
 * has run — sits in a metadata column that a counsellor can ignore entirely while
 * triaging and go to when they want to check the system's work.
 */

import Link from "next/link";

import { requireCounsellor } from "@/lib/auth/current";
import { unreviewed } from "@/lib/breakglass";
import { queue, queueStats } from "@/lib/queue";
import { allAlerts } from "@/lib/patterns";
import { Callout } from "@/components/callout";
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

  const [cases, stats] = await Promise.all([queue(), queueStats()]);
  const alerts = allAlerts();
  const budget = config.COUNSELLOR_WEEKLY_BUDGET;
  const openGlass = await unreviewed(await store());

  return (
    <main id="content" className="mx-auto w-full max-w-5xl px-4 py-8">
      <ConsoleHeader principal={principal} />

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Counsellor queue</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          <strong className="font-semibold text-ink">{stats.queued} cases</strong> need
          action, of {stats.total} conversations.{" "}
          {stats.byTier[Tier.T0] + stats.byTier[Tier.T1]} were logged with no action needed
          and are not shown.
        </p>

        <div className="mt-4 space-y-2.5">
          {stats.breakGlass > 0 && (
            <Callout tone="danger" role="alert">
              <strong className="font-semibold">
                {stats.breakGlass} case{stats.breakGlass === 1 ? "" : "s"} at T4 —
                immediate, break-glass now.
              </strong>{" "}
              Crisis resources were already shown to the student.
            </Callout>
          )}

          {/* The one control on break-glass is that these are visible and counted. Shown to
              everyone, not just leads: a counsellor seeing their own unreviewed closure sit
              here for a week is the feedback that keeps the threshold meaningful. */}
          {openGlass.length > 0 && (
            <Callout tone="warn">
              {openGlass.length} break-glass closure{openGlass.length === 1 ? "" : "s"}{" "}
              awaiting review by a safeguarding lead
              {principal.role === "lead" ? " — that is you." : "."}{" "}
              <span className="font-mono text-xs">
                {openGlass.map((r) => r.caseId).join(", ")}
              </span>
            </Callout>
          )}

          {stats.awaitingClassifier > 0 && (
            <Callout tone="insight">
              {stats.awaitingClassifier} case
              {stats.awaitingClassifier === 1 ? " is" : "s are"} from a live conversation
              and {stats.awaitingClassifier === 1 ? "has" : "have"} been scored by the
              safety gate only. The tier is a floor, not a prediction — the classifier has
              not run on {stats.awaitingClassifier === 1 ? "it" : "them"} yet.
            </Callout>
          )}
        </div>
      </header>

      <PatternAlertPanel alerts={alerts} />

      <ol className="space-y-2">
        {cases.map((card, i) => (
          <li key={card.caseId}>
            {/* The budget line: everything below it is unlikely to be seen this week.
                Drawn rather than hidden, because a counsellor should know the cut exists
                and be able to look past it. recall@budget is measured against this. */}
            {i === budget && (
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-line-strong" />
                <p className="max-w-md text-center text-xs leading-relaxed text-faint">
                  Below this line is beyond a typical week of {budget} cases. Measured
                  recall of T3 and T4 above the line is{" "}
                  <strong className="font-semibold text-muted">0.865 ±0.019</strong>{" "}
                  against a 0.90 target — see docs/results.md.
                </p>
                <span className="h-px flex-1 bg-line-strong" />
              </div>
            )}
            <Link
              href={`/console/${card.caseId}`}
              className="group flex items-start gap-4 rounded-2xl border border-line bg-surface p-4 transition-all hover:border-line-strong hover:shadow-lift"
            >
              <TierBadge tier={card.tier} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold tracking-tight">{card.handle}</span>
                  <span className="font-mono text-xs text-faint">{card.caseId}</span>
                  <span className="text-xs text-faint">
                    {card.nStudentTurns} messages
                  </span>
                </div>

                {/* The lead reason, not a summary. Deterministic, from the closed bank. */}
                <p className="mt-1 truncate text-sm text-muted">
                  {card.reasons[1] ?? card.reasons[0]}
                </p>

                {card.citedQuotes[0] && (
                  <p className="mt-1.5 truncate border-l-2 border-line-strong pl-2.5 text-sm italic text-faint">
                    &ldquo;{card.citedQuotes[0].text}&rdquo;
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                <div className="text-sm font-semibold tabular-nums">
                  {TIERS[card.tier].slaHours === 0
                    ? "now"
                    : `${TIERS[card.tier].slaHours}h`}
                </div>
                <div className="text-xs tabular-nums text-faint">
                  {card.confidence === null
                    ? "not scored"
                    : `conf ${card.confidence.toFixed(2)}`}
                </div>
                {/* A counsellor has to be able to tell a gate-only floor from a
                    classifier judgement at a glance: the two carry different amounts
                    of evidence, and the tier means different things. */}
                <div className="flex gap-1">
                  {card.tierFloorReason && (
                    <span className="rounded-md border border-warn-line bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn-ink">
                      gate
                    </span>
                  )}
                  {card.awaitingClassifier && (
                    <span className="rounded-md border border-insight-line bg-insight-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-insight-ink">
                      live
                    </span>
                  )}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ol>

      <p className="mt-8 border-t border-line pt-4 text-xs text-faint">
        Every conversation here is synthetic and hand-authored. No real student wrote any
        of it.
      </p>
    </main>
  );
}
