/**
 * The mark: a tower, a lamp, and two beams.
 *
 * Drawn rather than imported. It is a handful of path commands and the product has exactly
 * one piece of branding, so a dependency or an asset request for it would cost more than
 * it returns — and on the student side it has to render before anything else does.
 *
 * Shared by the chat header and the console header so the two interfaces read as one
 * product. Purely decorative: `aria-hidden`, and the word "Lighthouse" always sits next
 * to it in real text.
 */

export function LighthouseMark({ className = "size-8" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-xl bg-accent text-on-accent ${className}`}
    >
      {/*
        Filled shapes, not strokes.
        The first version drew the tower as a 1.6px outline, which at the 18px this
        renders on a phone collapsed into an unreadable smudge. Solid masses survive
        being small; hairlines do not.
      */}
      <svg viewBox="0 0 24 24" fill="none" className="size-[68%]">
        {/* tower, tapering out to the base. Starts where the lamp ends: a gap between the
            two reads as two floating shapes rather than one building. */}
        <path
          d="M9.5 9.7h5l1.2 8.9a.7.7 0 0 1-.7.8H9a.7.7 0 0 1-.7-.8l1.2-8.9Z"
          fill="currentColor"
        />
        {/* lamp room */}
        <rect x="9.7" y="5.6" width="4.6" height="4.2" rx="1" fill="currentColor" />
        {/* beams */}
        <path
          d="M6.6 5.9 4.1 4.8M17.4 5.9l2.5-1.1"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
