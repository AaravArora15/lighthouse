/**
 * The tier badge. One glance should tell a counsellor how fast they have to move.
 *
 * Colour carries urgency, but never alone: the tier code and the SLA are both in the
 * text, so the badge still works for a colourblind counsellor, in greyscale print, and in
 * a screen reader. Colour is the accelerator, not the message.
 */

import { Tier, TIERS } from "@/lib/taxonomy";

const STYLES: Record<Tier, string> = {
  [Tier.T0]: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
  [Tier.T1]: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
  [Tier.T2]: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  [Tier.T3]: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  [Tier.T4]: "bg-red-600 text-white dark:bg-red-700",
};

export function TierBadge({ tier, large = false }: { tier: Tier; large?: boolean }) {
  const spec = TIERS[tier];
  const sla =
    spec.slaHours === null ? "log only" : spec.slaHours === 0 ? "now" : `${spec.slaHours}h`;

  return (
    <span
      className={`inline-flex shrink-0 flex-col items-center rounded-lg font-semibold ${
        large ? "px-4 py-2 text-lg" : "px-2.5 py-1.5 text-sm"
      } ${STYLES[tier]}`}
    >
      {tier}
      <span className={`font-normal ${large ? "text-xs" : "text-[10px]"} opacity-80`}>
        {sla}
      </span>
      <span className="sr-only">
        {spec.meaning}. {spec.action}.
      </span>
    </span>
  );
}
