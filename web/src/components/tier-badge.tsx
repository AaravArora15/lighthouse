/**
 * The tier badge. One glance should tell a counsellor how fast they have to move.
 *
 * Colour carries urgency, but never alone: the tier code and the SLA are both in the
 * text, so the badge still works for a colourblind counsellor, in greyscale print, and in
 * a screen reader. Colour is the accelerator, not the message.
 *
 * T4 is the only **filled** badge. The others are tinted with a border, so on a queue of
 * twenty cases the eye lands on the one that means break-glass rather than having to sort
 * five similar-weight chips. Weight is doing the same job as hue, for the same reason the
 * text repeats what the colour says.
 */

import { Tier, TIERS } from "@/lib/taxonomy";

const STYLES: Record<Tier, string> = {
  [Tier.T0]: "border-line bg-sunk text-muted",
  [Tier.T1]: "border-line bg-sunk text-muted",
  [Tier.T2]: "border-calm-line bg-calm-soft text-calm-ink",
  [Tier.T3]: "border-warn-line bg-warn-soft text-warn-ink",
  // `text-danger-soft`, not `text-white`. In dark mode `--danger` is a light salmon and
  // white on it fails contrast; `--danger-soft` is near-white in light and near-black in
  // dark, so the pair reads correctly in both without a second rule.
  [Tier.T4]: "border-transparent bg-danger text-danger-soft shadow-soft",
};

export function TierBadge({ tier, large = false }: { tier: Tier; large?: boolean }) {
  const spec = TIERS[tier];
  const sla =
    spec.slaHours === null ? "log only" : spec.slaHours === 0 ? "now" : `${spec.slaHours}h`;

  return (
    <span
      className={`inline-flex shrink-0 flex-col items-center justify-center rounded-xl border font-semibold leading-none tabular-nums ${
        large ? "min-w-16 px-3 py-2.5 text-lg" : "min-w-12 px-2 py-1.5 text-sm"
      } ${STYLES[tier]}`}
    >
      {tier}
      <span
        className={`mt-1 font-medium ${large ? "text-[11px]" : "text-[10px]"} opacity-75`}
      >
        {sla}
      </span>
      <span className="sr-only">
        {spec.meaning}. {spec.action}.
      </span>
    </span>
  );
}
