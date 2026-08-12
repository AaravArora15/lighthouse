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
 * That ordering is also why the page is built from labelled sections rather than one
 * continuous column: a reader who stops early should be able to see exactly where they
 * stopped and what they skipped.
 *
 * Nothing here was written by a language model. Day 7 adds a summary paragraph and it will
 * be labelled as model prose; the card is complete without it.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BreakGlassPanel } from "@/components/break-glass-panel";
import { Callout } from "@/components/callout";
import { ConsoleHeader } from "@/components/console-header";
import { OverridePanel } from "@/components/override-panel";
import { RiskSparkline } from "@/components/risk-sparkline";
import { TierBadge } from "@/components/tier-badge";
import { TranscriptPanel } from "@/components/transcript-panel";
import { transcriptWasRead } from "@/lib/transcript";
import { accessForCase, describeAccess, recordAccess } from "@/lib/audit";
import { requireCounsellor } from "@/lib/auth/current";
import { breakGlassForCase } from "@/lib/breakglass";
import { caseById } from "@/lib/queue";
import { overrideFor } from "@/lib/overrides";
import { store } from "@/lib/store";
import { TIERS } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

/** A labelled block. One shape for every section so the page reads as a single document. */
function Section({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const principal = await requireCounsellor(`/console/${caseId}`);

  const card = await caseById(caseId);
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

  // Derived from the rows already fetched, so it costs no extra query. Per counsellor:
  // a colleague having read the case does not qualify this one to overrule the gate on it.
  const transcriptRead = transcriptWasRead(accesses, principal.counsellorId);

  return (
    <main id="content" className="mx-auto w-full max-w-3xl px-4 py-8">
      <ConsoleHeader principal={principal} />

      <Link
        href="/console"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-ink"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3.5"
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
        Queue
      </Link>

      <header className="mt-4 flex items-start gap-4 rounded-2xl border border-line bg-surface p-5">
        <TierBadge tier={card.tier} large />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{card.handle}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
            <span className="font-mono">{card.caseId}</span>
            <span aria-hidden>·</span>
            <span>{card.nStudentTurns} messages</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {card.confidence === null
                ? "not scored by the classifier yet"
                : `calibrated confidence ${card.confidence.toFixed(2)}`}
            </span>
          </p>
          <p className="mt-2.5 text-sm font-medium">{spec.action}</p>
        </div>
      </header>

      <div className="mt-4 space-y-2.5">
        {card.awaitingClassifier && (
          <Callout tone="insight">
            <strong className="font-semibold">Live conversation, gate-only triage.</strong>{" "}
            This case was created from a conversation happening now and has been scored by
            the deterministic safety gate alone. The tier below is a <em>floor</em> — the
            classifier has not run on it, so there is no confidence figure and the reasons
            come only from what the gate matched.
          </Callout>
        )}

        {card.crisisResourcesShown && (
          <Callout tone="danger">
            Crisis resources were shown to this student during the conversation, before any
            model output.
          </Callout>
        )}

        {/* The gate moved the tier. Say so, in the gate's own words. */}
        {card.tierFloorReason && (
          <Callout tone="warn">
            <strong className="font-semibold">Safety gate.</strong> The classifier proposed{" "}
            {card.modelTier}. {card.tierFloorReason}
          </Callout>
        )}
      </div>

      {/* ---- Why -------------------------------------------------------------- */}
      <Section title="Why" className="mt-7">
        <ul className="mt-2.5 space-y-2">
          {card.reasons.map((reason, i) => (
            <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ---- Evidence --------------------------------------------------------- */}
      <Section title="What the student said" className="mt-7">
        {card.citedQuotes.length === 0 ? (
          <p className="mt-2.5 text-sm text-muted">
            No individual message stood out. This case was queued on the shape of the
            conversation as a whole.
          </p>
        ) : (
          <ul className="mt-2.5 space-y-2.5">
            {card.citedQuotes.map((quote) => (
              <li
                key={quote.turnId}
                className="rounded-xl border border-line bg-surface px-4 py-3"
              >
                {/* Verbatim. Sliced by offset from the original turn. */}
                <p className="text-[15px] leading-relaxed">&ldquo;{quote.text}&rdquo;</p>
                <p className="mt-1.5 text-xs text-faint">
                  {quote.turnId.replace("turn-", "message ")} · {quote.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
        {/* This paragraph used to read "the full transcript is available only on
            escalation, with a logged reason" over a path that did not exist, and it also
            carried a `length === 3 ? "3" : "3"` ternary. Both are gone. What it says now
            is the actual selection rule, because that is the thing a counsellor has to
            know before weighing this list. */}
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Quoted exactly as written, at most 3 per card, and chosen as the highest-scoring
          turns. They are the evidence <em>for</em> this tier, so they cannot tell you it is
          wrong. The full conversation is below.
        </p>
      </Section>

      {/* ---- Shape of the conversation ---------------------------------------- */}
      {card.sessionTimeline.length > 1 && (
        <Section title="How it developed" className="mt-7">
          <RiskSparkline points={card.sessionTimeline} />
        </Section>
      )}

      {/* ---- The conversation -------------------------------------------------- */}
      {/* Sits above the two controls it gates, because it is a precondition for them and
          not an appendix to the card. See lib/transcript.ts and context.md §17. */}
      <Section title="The conversation" className="mt-8 border-t border-line pt-7">
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Everything above is evidence the classifier and the gate selected because it
          agrees with the tier. If you are going to disagree with the tier, read the rest
          first.
        </p>
        <TranscriptPanel caseId={card.caseId} alreadyRead={transcriptRead} />
      </Section>

      {/* ---- Override --------------------------------------------------------- */}
      <Section title="Disagree with this?" className="mt-8 border-t border-line pt-7">
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Your judgement is recorded alongside the model&rsquo;s, not instead of it. The
          reason is what makes it useful later.
        </p>
        <OverridePanel
          caseId={card.caseId}
          predictedTier={card.tier}
          existing={override ?? null}
          persisted={db.kind === "postgres"}
          transcriptRead={transcriptRead}
        />
      </Section>

      {/* Only where there is a floor to break. On an unfloored case an ordinary override
          already does everything this would, so offering it would be noise that teaches
          counsellors to click past the red panel. */}
      {card.gateFloor && (
        <BreakGlassPanel
          caseId={card.caseId}
          gateFloor={card.gateFloor}
          existing={glass}
          viewer={{ counsellorId: principal.counsellorId, role: principal.role }}
          transcriptRead={transcriptRead}
        />
      )}

      {/* ---- The record the student can read ----------------------------------- */}
      <Section title="Who has opened this case" className="mt-8 border-t border-line pt-7">
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Shown to you because it is shown to the student. Nothing on this list can be
          edited or removed, including by whoever wrote it.
          {card.awaitingClassifier !== undefined && (
            <>
              {" "}
              <Link
                href={`/c/${card.caseId}`}
                className="font-medium text-accent-text underline decoration-accent-line decoration-2 underline-offset-4 hover:decoration-accent-text"
              >
                See their view
              </Link>
              .
            </>
          )}
        </p>
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {accesses.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
              <span className="shrink-0 tabular-nums text-faint">
                {new Date(entry.at).toLocaleString()}
              </span>
              <span className="min-w-0 flex-1">{describeAccess(entry)}</span>
              <span className="shrink-0 text-faint">{entry.counsellorEmail}</span>
              {entry.reason && (
                <span className="w-full italic text-muted">
                  &ldquo;{entry.reason}&rdquo;
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <p className="mt-8 border-t border-line pt-4 text-xs text-faint">
        Synthetic conversation. Retention:{" "}
        {card.retentionExpiresAt
          ? new Date(card.retentionExpiresAt).toLocaleDateString()
          : "exempt — escalated cases are not auto-deleted"}
        .
      </p>
    </main>
  );
}
