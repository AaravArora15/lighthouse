/**
 * The escalation card, as a counsellor reads it.
 *
 * The ordering on this page is the argument the product is making, so it is deliberate:
 * tier and SLA, then **why** (closed-bank reasons), then **evidence** (the student's own
 * words, verbatim), then the shape of the conversation, then the override control.
 *
 * A counsellor should be able to stop reading after the reasons and still be acting on
 * something defensible. Everything below that point is for the cases where they want to
 * check the system's work — which is the whole reason the evidence is quoted rather than
 * summarised.
 *
 * Nothing here was written by a language model. Day 7 adds a summary paragraph and it will
 * be labelled as model prose; the card is complete without it.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { BreakGlassPanel } from "@/components/break-glass-panel";
import { ConsoleHeader } from "@/components/console-header";
import { OverridePanel } from "@/components/override-panel";
import { RiskSparkline } from "@/components/risk-sparkline";
import { TierBadge } from "@/components/tier-badge";
import { accessForCase, describeAccess, recordAccess } from "@/lib/audit";
import { requireCounsellor } from "@/lib/auth/current";
import { breakGlassForCase } from "@/lib/breakglass";
import { cardById } from "@/lib/cards";
import { overrideFor } from "@/lib/overrides";
import { store } from "@/lib/store";
import { TIERS } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

export default async function CardPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const principal = await requireCounsellor(`/console/${caseId}`);

  const card = cardById(caseId);
  if (!card) notFound();

  const db = await store();

  // Every read of a case is logged, before anything is rendered. `docs/context.md` §11
  // promises the student can see who opened their case, and a promise nothing records is
  // not a promise. Written first so a render that throws halfway still leaves the record
  // of the access that was already granted.
  await recordAccess(db, { caseId, principal, action: "viewed_card" });

  const [override, glass, accesses] = await Promise.all([
    overrideFor(db, caseId),
    breakGlassForCase(db, caseId),
    accessForCase(db, caseId),
  ]);
  const spec = TIERS[card.tier];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <ConsoleHeader principal={principal} />

      <Link
        href="/console"
        className="text-sm text-stone-500 underline-offset-4 hover:underline dark:text-stone-400"
      >
        ← Queue
      </Link>

      <header className="mt-4 flex items-start gap-4">
        <TierBadge tier={card.tier} large />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{card.handle}</h1>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {card.caseId} · {card.nStudentTurns} messages · calibrated confidence{" "}
            {card.confidence.toFixed(2)}
          </p>
          <p className="mt-1 text-sm font-medium">{spec.action}</p>
        </div>
      </header>

      {card.crisisResourcesShown && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-100">
          Crisis resources were shown to this student during the conversation, before any
          model output.
        </p>
      )}

      {/* The gate moved the tier. Say so, in the gate's own words. */}
      {card.tierFloorReason && (
        <section className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-950/30">
          <strong className="font-medium">Safety gate.</strong> The classifier proposed{" "}
          {card.modelTier}. {card.tierFloorReason}
        </section>
      )}

      {/* ---- Why -------------------------------------------------------------- */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Why
        </h2>
        <ul className="mt-2 space-y-1.5">
          {card.reasons.map((reason, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span aria-hidden className="text-stone-400">
                •
              </span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- Evidence --------------------------------------------------------- */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          What the student said
        </h2>
        {card.citedQuotes.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
            No individual message stood out. This case was queued on the shape of the
            conversation as a whole.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {card.citedQuotes.map((quote) => (
              <li
                key={quote.turnId}
                className="border-l-2 border-stone-300 pl-3 dark:border-stone-700"
              >
                {/* Verbatim. Sliced by offset from the original turn. */}
                <p className="text-sm">&ldquo;{quote.text}&rdquo;</p>
                <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                  {quote.turnId.replace("turn-", "message ")} · {quote.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          Quoted exactly as written, at most {card.citedQuotes.length === 3 ? "3" : "3"}{" "}
          per card. The full transcript is available only on escalation, with a logged
          reason.
        </p>
      </section>

      {/* ---- Shape of the conversation ---------------------------------------- */}
      {card.sessionTimeline.length > 1 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            How it developed
          </h2>
          <RiskSparkline points={card.sessionTimeline} />
        </section>
      )}

      {/* ---- Override --------------------------------------------------------- */}
      <section className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Disagree with this?
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Your judgement is recorded alongside the model&rsquo;s, not instead of it. The
          reason is what makes it useful later.
        </p>
        <OverridePanel
          caseId={card.caseId}
          predictedTier={card.tier}
          existing={override ?? null}
          persisted={db.kind === "postgres"}
        />
      </section>

      {/* Only where there is a floor to break. On an unfloored case an ordinary override
          already does everything this would, so offering it would be noise that teaches
          counsellors to click past the red panel. */}
      {card.gateFloor && (
        <BreakGlassPanel
          caseId={card.caseId}
          gateFloor={card.gateFloor}
          existing={glass}
          viewer={{ counsellorId: principal.counsellorId, role: principal.role }}
        />
      )}

      {/* ---- The record the student can read ----------------------------------- */}
      <section className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Who has opened this case
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Shown to you because it is shown to the student. Nothing on this list can be
          edited or removed, including by whoever wrote it.
        </p>
        <ul className="mt-3 space-y-1.5 text-sm">
          {accesses.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-2 gap-y-0.5">
              <span className="tabular-nums text-stone-500 dark:text-stone-400">
                {new Date(entry.at).toLocaleString()}
              </span>
              <span>{describeAccess(entry)}</span>
              <span className="text-stone-500 dark:text-stone-400">
                {entry.counsellorEmail}
              </span>
              {entry.reason && (
                <span className="w-full italic text-stone-500 dark:text-stone-400">
                  &ldquo;{entry.reason}&rdquo;
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-xs text-stone-500 dark:text-stone-400">
        Synthetic conversation. Retention:{" "}
        {card.retentionExpiresAt
          ? new Date(card.retentionExpiresAt).toLocaleDateString()
          : "exempt — escalated cases are not auto-deleted"}
        .
      </p>
    </main>
  );
}
