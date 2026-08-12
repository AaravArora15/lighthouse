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
 *
 * ## Why the number is the biggest thing on it
 *
 * The one action this banner exists to make easy is *dialling*. So each number is set at
 * display size, in tabular figures, on its own filled tap target, and the surrounding
 * prose is deliberately smaller than it. A student reading this is not skimming a layout;
 * they are looking for something to press. It is self-contained — its own surface, border
 * and spacing — because it renders on the chat and again on the student's receipt.
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
      className="overflow-hidden rounded-2xl border border-warn-line bg-warn-soft shadow-soft"
    >
      <div className="px-4 pb-3.5 pt-3">
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-warn/15 text-warn"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              className="size-3.5"
            >
              <path d="M12 8v5M12 16.5v.01" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-6 text-warn-ink">
              If you need to talk to someone right now
            </h2>
            <p className="mt-0.5 text-sm leading-relaxed text-muted">
              These are real people, free to call, any time of day or night.
            </p>
          </div>
        </div>

        {/*
          Dense on purpose. This block sits above the transcript and never scrolls away,
          so every line it spends is a line of conversation a student on a phone does not
          get. The alternative and the note wrap onto the name's row where they fit rather
          than each claiming a full line of their own.
        */}
        <ul className="mt-3 space-y-1.5">
          {resources.map((r) => (
            <li
              key={r.name}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-warn-line/60 bg-surface/70 px-2.5 py-2"
            >
              <a
                href={telHref(r.contact)}
                className="shrink-0 rounded-lg border border-warn-line bg-warn/15 px-2.5 py-1 text-2xl font-bold tabular-nums tracking-tight text-warn-ink transition-colors hover:bg-warn/25"
              >
                {r.contact}
              </a>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-5">{r.name}</p>
                <p className="text-xs leading-5 text-muted">{r.hours}</p>
              </div>
              {r.alternative && (
                <span className="text-xs leading-snug text-muted">
                  {r.alternative.label}:{" "}
                  <span className="font-medium text-ink">{r.alternative.value}</span>
                </span>
              )}
              {r.note && (
                <span className="text-xs leading-snug text-muted">{r.note}</span>
              )}
            </li>
          ))}
        </ul>

        <p className="mt-2.5 text-sm leading-relaxed text-muted">
          You can keep talking here as well. This chat is still open.
        </p>
      </div>
    </aside>
  );
}
