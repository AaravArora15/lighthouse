/**
 * The student's own receipt.
 *
 * `docs/context.md` §11 promised "audit log of every counsellor access, visible to the
 * student". Until this page existed the counsellor's screen displayed the sentence
 * *"Shown to you because it is shown to the student"* above a log no student could reach.
 * That was a privacy claim rendered on screen with nothing behind it.
 *
 * ## Not authenticated, and that is the design
 *
 * There is no account. The student is anonymous, which is the whole point, so there is
 * nothing to authenticate against and the URL itself is the credential. `newCaseId` is
 * therefore 128 bits of CSPRNG output rather than something guessable.
 *
 * ## Viewing your own case is not logged
 *
 * `counsellor_access` answers exactly one question: which *adult* looked at this child's
 * material. Writing a row every time the student refreshes their own page would bury the
 * answer in noise and imply the student is being monitored for reading about themselves.
 *
 * ## What is deliberately absent
 *
 * No tier. No confidence score. No gate indicators, no queue rank, no counsellor names
 * beyond the email already in the log. See `lib/student.ts` for why a severity label is
 * not a thing to show a thirteen-year-old about themselves.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { CrisisBanner } from "@/components/crisis-banner";
import { describeAccess } from "@/lib/audit";
import * as config from "@/lib/config";
import { caseById } from "@/lib/queue";
import { REDACTION_NOTE, retentionFor, statusFor } from "@/lib/student";
import { store } from "@/lib/store";
import { Tier } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;

  // Seeded `syn-` cases are demo material and belong to nobody. Refusing them here means a
  // guessed URL cannot be used to browse the synthetic corpus through the student surface.
  if (!caseId.startsWith("live-")) notFound();

  const card = await caseById(caseId);
  if (!card) notFound();

  const db = await store();
  const [turns, accesses] = await Promise.all([
    db.turnsForCase(caseId),
    db.accessForCase(caseId),
  ]);

  const status = statusFor(card);

  return (
    <main id="content" className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Your conversation</h1>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
        This page is yours. Keep the link if you want to come back to it.
      </p>

      {/* The same numbers, on the same terms, wherever a student might be reading this. */}
      {card.tier === Tier.T4 && (
        <div className="mt-6">
          <CrisisBanner resources={config.CRISIS_RESOURCES} />
        </div>
      )}

      {/* ---- What happens next. Never a tier. ---------------------------------- */}
      <section className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="text-base font-medium">{status.headline}</h2>
        {status.detail && (
          <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">{status.detail}</p>
        )}
      </section>

      {/* ---- Who has opened it. The promise this page exists for. -------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Who has opened your conversation
        </h2>
        {accesses.length === 0 ? (
          <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
            Nobody has opened it yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {accesses.map((entry) => (
              <li
                key={entry.id}
                className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800"
              >
                <p>{describeAccess(entry)}</p>
                <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                  {entry.counsellorEmail} · {new Date(entry.at).toLocaleString()}
                </p>
                {entry.reason && (
                  <p className="mt-1 text-xs italic text-stone-600 dark:text-stone-400">
                    Their reason: &ldquo;{entry.reason}&rdquo;
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          This list cannot be edited or deleted by anyone, including the person who opened
          your conversation.
        </p>
      </section>

      {/* ---- What was saved -------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          What was saved
        </h2>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">{REDACTION_NOTE}</p>
        <ul className="mt-3 space-y-2">
          {turns
            .filter((t) => t.role === "student")
            .map((turn) => (
              <li
                key={turn.ordinal}
                className="border-l-2 border-stone-300 pl-3 text-sm dark:border-stone-700"
              >
                {turn.text}
              </li>
            ))}
        </ul>
      </section>

      {/* ---- Retention ------------------------------------------------------- */}
      <section className="mt-8 border-t border-stone-200 pt-6 dark:border-stone-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          How long this is kept
        </h2>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">{retentionFor(card)}</p>
      </section>

      <p className="mt-8 text-xs text-stone-500 dark:text-stone-400">
        Anyone with this link can read this page, so only share it with someone you trust.{" "}
        <Link href="/" className="underline underline-offset-4">
          Back to the chat
        </Link>
        .
      </p>
    </main>
  );
}
