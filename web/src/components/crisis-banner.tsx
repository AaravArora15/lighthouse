/**
 * The crisis banner.
 *
 * Renders when the safety gate floors a conversation at T4, and it is the single most
 * important thing this application draws. Three rules govern it, all from CLAUDE.md:
 *
 * 1. **It appears before any model output.** The route writes the `gate` SSE event before
 *    it calls the model, so this component mounts while the reply is still being
 *    generated. That ordering lives in `app/api/chat/route.ts`; do not add a loading
 *    state here that waits for anything.
 * 2. **It is never dismissed by model output.** There is no prop that can hide it once
 *    shown. The parent holds `showCrisis` as a latch, so a later calm turn cannot take
 *    the numbers off a student's screen mid-crisis.
 * 3. **It does not replace the conversation.** It sits above the transcript and the chat
 *    continues underneath. A student who discloses the hardest thing they have ever said
 *    and gets only a phone number has been dismissed at the worst possible moment.
 *
 * Every number is 24/7 and verified — see the note on `CRISIS_RESOURCES` in `config.ts`
 * for why that constraint is enforced there rather than here.
 */

import type { CrisisResource } from "@/lib/config";

/** `1767` -> `tel:1767`, `9151 1767` -> `tel:91511767`. */
function telHref(contact: string): string {
  return `tel:${contact.replace(/[^\d+]/g, "")}`;
}

export function CrisisBanner({ resources }: { resources: readonly CrisisResource[] }) {
  if (resources.length === 0) return null;

  return (
    <aside
      // `assertive` on purpose. This is the one announcement in the product that should
      // interrupt a screen reader rather than wait its turn.
      role="alert"
      aria-live="assertive"
      aria-label="Immediate support"
      className="rounded-2xl border border-amber-300/70 bg-amber-50 p-5 text-stone-900 shadow-sm dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-50"
    >
      <h2 className="text-base font-semibold">
        If you need to talk to someone right now
      </h2>
      <p className="mt-1 text-sm text-stone-700 dark:text-amber-100/80">
        These are real people, free to call, any time of day or night.
      </p>

      <ul className="mt-4 space-y-3">
        {resources.map((r) => (
          <li key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <a
              href={telHref(r.contact)}
              className="text-xl font-semibold tracking-tight underline decoration-amber-400 decoration-2 underline-offset-4 hover:decoration-amber-600"
            >
              {r.contact}
            </a>
            <span className="font-medium">{r.name}</span>
            <span className="text-sm text-stone-600 dark:text-amber-100/70">{r.hours}</span>
            {r.alternative && (
              <span className="w-full text-sm text-stone-600 dark:text-amber-100/70">
                {r.alternative.label}: <span className="font-medium">{r.alternative.value}</span>
              </span>
            )}
            {r.note && (
              <span className="w-full text-sm text-stone-600 dark:text-amber-100/70">
                {r.note}
              </span>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-4 text-sm text-stone-600 dark:text-amber-100/70">
        You can keep talking here as well. This chat is still open.
      </p>
    </aside>
  );
}
