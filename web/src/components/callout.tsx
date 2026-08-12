/**
 * A bordered notice, in one of the product's four meanings.
 *
 * The console had five hand-rolled variants of this shape — red for break-glass, amber for
 * the gate, violet for the classifier queue, and two more on the card — each with its own
 * padding, radius and dark-mode pair. They drifted, and a counsellor learning that "amber
 * means the gate moved it" should not have to relearn it per screen.
 *
 * The tones are semantic and fixed:
 *
 * | tone      | means                                        |
 * |-----------|----------------------------------------------|
 * | `danger`  | act now: T4, crisis resources, break-glass   |
 * | `warn`    | the safety gate changed something            |
 * | `insight` | a cross-conversation pattern. Never urgent.  |
 * | `calm`    | informational: what the system has not done  |
 *
 * `docs/context.md` §6 turns on a counsellor being able to tell "the gate floored this"
 * from "act now" at a glance, so keeping those two in different colours is a product
 * requirement rather than a style preference.
 */

import type { ReactNode } from "react";

export type Tone = "danger" | "warn" | "insight" | "calm";

const TONES: Record<Tone, string> = {
  danger: "border-danger-line bg-danger-soft text-danger-ink",
  warn: "border-warn-line bg-warn-soft text-warn-ink",
  insight: "border-insight-line bg-insight-soft text-insight-ink",
  calm: "border-calm-line bg-calm-soft text-calm-ink",
};

const DOTS: Record<Tone, string> = {
  danger: "bg-danger",
  warn: "bg-warn",
  insight: "bg-insight",
  calm: "bg-calm",
};

export function Callout({
  tone,
  children,
  role,
  className = "",
}: {
  tone: Tone;
  children: ReactNode;
  /** `alert` where a screen reader should be told without waiting its turn. */
  role?: "alert";
  className?: string;
}) {
  return (
    <div
      role={role}
      className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-relaxed ${TONES[tone]} ${className}`}
    >
      {/* A dot rather than an icon set. It carries the tone for anyone reading quickly
          and costs nothing to a screen reader, which gets the sentence instead. */}
      <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${DOTS[tone]}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
