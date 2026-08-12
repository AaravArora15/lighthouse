/**
 * Per-turn risk across the conversation.
 *
 * Inline SVG, no chart library: this is eight to twelve points and a polyline, and pulling
 * in a charting dependency for it would cost more than it returns.
 *
 * What it is *for* is the trend, which is the thing a single tier cannot express. A
 * conversation that ends at its worst moment reads differently from one that peaked early
 * and settled, and `features.py` encodes exactly that (`trend_slope`, `peak_position`).
 * This is the counsellor-facing view of the same signal.
 *
 * The axis is fixed 0..1 rather than fitted to the data. Auto-scaling would make a calm
 * conversation's noise look like an escalating one, which is precisely the misreading this
 * chart exists to prevent. The 0 and 1 are printed on the plot for the same reason: an
 * unlabelled axis invites the reader to assume it was fitted.
 *
 * Colour comes from `currentColor` on the `<svg>`, so the line, the area fill and the
 * dots all follow the accent token through a theme change without three separate
 * dark-mode pairs.
 */

import * as config from "@/lib/config";
import type { TimelinePoint } from "@/lib/cards";

const W = 600;
const H = 110;
const PAD_X = 8;
const PAD_Y = 10;

export function RiskSparkline({ points }: { points: TimelinePoint[] }) {
  if (points.length < 2) return null;

  const x = (i: number) => PAD_X + (i / (points.length - 1)) * (W - 2 * PAD_X);
  const y = (risk: number) => H - PAD_Y - risk * (H - 2 * PAD_Y);

  const line = points.map((p, i) => `${x(i)},${y(p.risk)}`).join(" ");
  // The same path closed along the baseline, so the area under the curve can be tinted.
  const area = `${line} ${x(points.length - 1)},${H - PAD_Y} ${x(0)},${H - PAD_Y}`;
  const peak = points.reduce((a, b) => (b.risk > a.risk ? b : a));

  return (
    <div className="mt-2 rounded-2xl border border-line bg-surface p-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        // Height follows the viewBox aspect. `preserveAspectRatio="none"` would stretch
        // the plot to fill the box and turn every dot into an ellipse.
        className="h-auto w-full text-accent-text"
        role="img"
        aria-label={`Risk across ${points.length} messages. Highest at message ${
          peak.ordinal + 1
        }, ${peak.risk.toFixed(2)}.`}
      >
        <defs>
          <linearGradient id="risk-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Top and bottom of the fixed axis, drawn so the reader can see the scale was
            not fitted to this conversation. */}
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={y(1)}
          y2={y(1)}
          className="stroke-line"
          strokeWidth={1}
        />
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={y(0)}
          y2={y(0)}
          className="stroke-line"
          strokeWidth={1}
        />

        {/* The concern threshold the features count against, so the reader can see which
            turns actually cleared it rather than guessing from the curve's shape. */}
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={y(config.CONCERN_THRESHOLD)}
          y2={y(config.CONCERN_THRESHOLD)}
          className="stroke-line-strong"
          strokeDasharray="5 5"
          strokeWidth={1}
        />

        <polygon points={area} fill="url(#risk-area)" />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {points.map((p, i) => (
          <circle
            key={p.turnId}
            cx={x(i)}
            cy={y(p.risk)}
            r={p === peak ? 4.5 : 2.5}
            className={p === peak ? "fill-warn stroke-surface" : "fill-current"}
            strokeWidth={p === peak ? 2 : 0}
          />
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-accent-text" />
          Per-message risk, first to last
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-0 w-4 border-t border-dashed border-line-strong"
          />
          Concern threshold ({config.CONCERN_THRESHOLD})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full bg-warn" />
          Peak at message {peak.ordinal + 1}
        </span>
      </div>
    </div>
  );
}
