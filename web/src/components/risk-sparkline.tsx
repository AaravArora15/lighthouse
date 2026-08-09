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
 * chart exists to prevent.
 */

import * as config from "@/lib/config";
import type { TimelinePoint } from "@/lib/cards";

const W = 600;
const H = 80;
const PAD = 4;

export function RiskSparkline({ points }: { points: TimelinePoint[] }) {
  if (points.length < 2) return null;

  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (risk: number) => H - PAD - risk * (H - 2 * PAD);

  const line = points.map((p, i) => `${x(i)},${y(p.risk)}`).join(" ");
  const peak = points.reduce((a, b) => (b.risk > a.risk ? b : a));

  return (
    <div className="mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-20 w-full"
        role="img"
        aria-label={`Risk across ${points.length} messages. Highest at message ${
          peak.ordinal + 1
        }, ${peak.risk.toFixed(2)}.`}
      >
        {/* The concern threshold the features count against, so the reader can see which
            turns actually cleared it rather than guessing from the curve's shape. */}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={y(config.CONCERN_THRESHOLD)}
          y2={y(config.CONCERN_THRESHOLD)}
          className="stroke-stone-300 dark:stroke-stone-700"
          strokeDasharray="4 4"
          strokeWidth={1}
        />
        <polyline
          points={line}
          fill="none"
          className="stroke-sky-600 dark:stroke-sky-400"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {points.map((p, i) => (
          <circle
            key={p.turnId}
            cx={x(i)}
            cy={y(p.risk)}
            r={p === peak ? 4 : 2.5}
            className={
              p === peak
                ? "fill-amber-500"
                : "fill-sky-600 dark:fill-sky-400"
            }
          />
        ))}
      </svg>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Per-message risk, first to last. Dashed line is the concern threshold (
        {config.CONCERN_THRESHOLD}). Peak at message {peak.ordinal + 1}.
      </p>
    </div>
  );
}
