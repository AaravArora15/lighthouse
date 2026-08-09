/**
 * The deterministic safety gate — TypeScript mirror of `ml/lighthouse/gate/safety.py`.
 *
 *     import { evaluateTurn, evaluateConversation, applyVerdict } from "@/lib/gate/safety";
 *
 * Runs **before** the conversational model on every student turn. It emits floors and
 * ceilings, never a final decision. See `docs/context.md` section 6.
 *
 * ## The two invariants
 *
 * - **No model output may lower a gate floor.** Enforced in exactly one place,
 *   `applyVerdict`, via `taxonomy.applyFloor`.
 * - **The gate never returns a tier.** It returns a floor, a ceiling and a score. If you
 *   ever find yourself wanting `verdict.tier`, you are about to break the thesis this
 *   whole project rests on.
 *
 * ## Scoring
 *
 * Per category, take the highest-severity match, not the count: a student repeating "i
 * want to die" four times is not four times the risk, and rewarding repetition would make
 * the score a function of how much someone types. Combine categories with noisy-OR,
 * `1 - prod(1 - w)`. Modifiers contribute only when a real category has already fired,
 * because "see you tomorrow" must not tint the score.
 */

import * as config from "@/lib/config";
import {
  COMPILED_PATTERNS,
  COMPILED_SUPPRESSORS,
  SEVERITY_ORDER,
  Severity,
  normalize,
} from "@/lib/gate/patterns";
import {
  GATE_CATEGORIES,
  GATE_CATEGORY_ORDER,
  GATE_MODIFIERS,
  GateCategory,
  Tier,
  applyFloor,
  gateFloor,
  tierRank,
  TIER_ORDER,
} from "@/lib/taxonomy";

/** Score band. Drives UI behaviour, not tier assignment. */
export enum GateLevel {
  CLEAR = "clear",
  /** Uncertain. Does not floor. Marks the case for the conversation head. */
  GREY = "grey",
  /** Crisis resources render unconditionally, before any model output. */
  HIGH = "high",
}

const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = {
  [Severity.STRONG]: config.GATE_SEVERITY_WEIGHTS.strong,
  [Severity.MODERATE]: config.GATE_SEVERITY_WEIGHTS.moderate,
  [Severity.WEAK]: config.GATE_SEVERITY_WEIGHTS.weak,
};

const CEILING_WITHOUT_T4 = config.GATE_CEILING_WITHOUT_T4_EVIDENCE as Tier;

/** One pattern match, with enough provenance to justify it to a counsellor. */
export interface GateHit {
  readonly category: GateCategory;
  readonly severity: Severity;
  /** The human-readable pattern name, e.g. `first_person_cutting`. Never the regex. */
  readonly pattern: string;
  readonly turnIndex: number;
  /**
   * Offsets into the ORIGINAL turn text, not the normalised copy. `normalize` is
   * length-preserving precisely so this holds.
   */
  readonly span: readonly [number, number];
  /** The verbatim matched substring, sliced from the original so casing survives. */
  readonly text: string;
}

export function hitWeight(hit: GateHit): number {
  return SEVERITY_WEIGHT[hit.severity];
}

export function describeHit(hit: GateHit): string {
  return `${hit.category} / ${hit.pattern}`;
}

/**
 * What the gate emits. Shape locked in `docs/context.md` section 6.
 *
 * Note what is absent: a tier. The gate constrains, it does not decide.
 */
export interface SafetyVerdict {
  readonly score: number;
  readonly level: GateLevel;
  readonly indicators: readonly GateHit[];
  readonly floor: Tier | null;
  readonly ceiling: Tier | null;
  readonly turnCount: number;
}

export function isHigh(v: SafetyVerdict): boolean {
  return v.level === GateLevel.HIGH;
}

export function isGrey(v: SafetyVerdict): boolean {
  return v.level === GateLevel.GREY;
}

/** Fired categories, in taxonomy order. Deterministic across runs. */
export function firedCategories(v: SafetyVerdict): GateCategory[] {
  const fired = new Set(v.indicators.map((h) => h.category));
  return GATE_CATEGORY_ORDER.filter((c) => fired.has(c));
}

/** The `gateIndicators` field of the escalation card (context.md section 7). */
export function indicatorNames(v: SafetyVerdict): string[] {
  return firedCategories(v);
}

/**
 * Crisis numbers render on this, unconditionally and before any model output.
 *
 * Keyed off the T4 floor rather than off `isHigh`, because the two can diverge: a single
 * STRONG threat plus a time marker scores 1.0 and floors at T4, while two MODERATE weapon
 * hits score high without any self-harm or abuse evidence at all. The student-facing
 * crisis card follows the T4 floor.
 */
export function requiresCrisisResources(v: SafetyVerdict): boolean {
  return v.floor === Tier.T4;
}

/** Highest-severity hits first, then earliest turn. What the card quotes. */
export function topHits(v: SafetyVerdict, limit = config.MAX_CITED_QUOTES): GateHit[] {
  return [...v.indicators]
    .sort(
      (a, b) =>
        hitWeight(b) - hitWeight(a) ||
        a.turnIndex - b.turnIndex ||
        a.span[0] - b.span[0],
    )
    .slice(0, limit);
}

/** Serialisable form. Field names match `SafetyVerdict.to_dict()` for the conformance test. */
export function verdictToDict(v: SafetyVerdict): Record<string, unknown> {
  return {
    score: Math.round(v.score * 1e4) / 1e4,
    level: v.level,
    is_high: isHigh(v),
    is_grey: isGrey(v),
    indicators: indicatorNames(v),
    floor: v.floor ?? null,
    ceiling: v.ceiling ?? null,
    hits: v.indicators.map((h) => ({
      category: h.category,
      pattern: h.pattern,
      severity: h.severity,
      turn_index: h.turnIndex,
      text: h.text,
    })),
  };
}

// ---------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------

type Span = readonly [number, number];

/**
 * The haystacks every pattern is run against: plain lowercase, and de-leetspeaked.
 *
 * Both, not just the normalised one. `normalize` maps digits to letters, so `"5"` becomes
 * `"s"` and every pattern that needs a digit stops working. That is exactly how "we walked
 * 5 kms for the charity thing" got a T4 floor in testing: the `distance_kms` suppressor
 * could no longer see the `5`, so `kms` read as "kill myself". Spans are interchangeable
 * because `normalize` is length-preserving.
 */
function variants(text: string): string[] {
  const lowered = text.toLowerCase();
  const normalised = normalize(text);
  return lowered === normalised ? [lowered] : [lowered, normalised];
}

function suppressedSpans(category: GateCategory, haystacks: string[]): Span[] {
  const spans: Span[] = [];
  for (const { rx } of COMPILED_SUPPRESSORS[category]) {
    for (const haystack of haystacks) {
      for (const m of haystack.matchAll(rx)) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }
  }
  return spans;
}

/**
 * True when the match sits inside a suppressor's span.
 *
 * Containment, not mere co-occurrence. "he told me to kill myself, and honestly i do want
 * to die" must suppress the first clause and keep the second: an anywhere-in-the-text
 * suppressor would throw away the disclosure that matters.
 */
function isSuppressed(span: Span, suppressed: readonly Span[]): boolean {
  const [start, end] = span;
  return suppressed.some(([s, e]) => s <= start && end <= e);
}

function overlapsAny(span: Span, taken: readonly Span[]): boolean {
  const [start, end] = span;
  return taken.some(([s, e]) => start < e && s < end);
}

function hitsForTurn(text: string, turnIndex: number): GateHit[] {
  const haystacks = variants(text);
  const hits: GateHit[] = [];

  for (const category of GATE_CATEGORY_ORDER) {
    const bank = COMPILED_PATTERNS[category];
    const suppressed = suppressedSpans(category, haystacks);
    // Highest severity first, then drop any later match that overlaps one already taken.
    // Without this, "someone brought a knife to school" reports three separate
    // weapon_mention hits for one phrase, and the card quotes the same eight words three
    // times. Severity order means the survivor is the strongest reading.
    const taken: Span[] = [];
    for (const severity of [...SEVERITY_ORDER].reverse()) {
      for (const { name, rx } of bank[severity] ?? []) {
        for (const haystack of haystacks) {
          for (const m of haystack.matchAll(rx)) {
            const span: Span = [m.index, m.index + m[0].length];
            if (overlapsAny(span, taken) || isSuppressed(span, suppressed)) continue;
            taken.push(span);
            hits.push({
              category,
              severity,
              pattern: name,
              turnIndex,
              span,
              // Sliced from the ORIGINAL, so casing and leetspeak survive into the
              // counsellor's view of what was actually written.
              text: text.slice(span[0], span[1]),
            });
          }
        }
      }
    }
  }
  return hits;
}

/** Noisy-OR over per-category maxima. Modifiers only count alongside a real category. */
function score(hits: readonly GateHit[]): number {
  const perCategory = new Map<GateCategory, number>();
  for (const hit of hits) {
    perCategory.set(
      hit.category,
      Math.max(perCategory.get(hit.category) ?? 0, hitWeight(hit)),
    );
  }

  const substantive = [...perCategory.keys()].filter((c) => !GATE_MODIFIERS.has(c));
  if (substantive.length === 0) {
    // Only modifiers fired. "after school" on its own is not a risk signal, and a gate
    // that greys out every conversation mentioning lunchtime is a gate nobody reads.
    return 0.0;
  }

  // Past this line a real category fired, so the modifier is allowed to contribute.
  let product = 1.0;
  for (const weight of perCategory.values()) product *= 1.0 - weight;
  return 1.0 - product;
}

function levelFor(value: number): GateLevel {
  if (value >= config.GATE_HIGH_SCORE) return GateLevel.HIGH;
  if (value >= config.GATE_GREY_SCORE) return GateLevel.GREY;
  return GateLevel.CLEAR;
}

/** One tier down. `T1` demotes to null, i.e. no floor worth recording. */
function demote(tier: Tier): Tier | null {
  const rank = tierRank(tier);
  return rank >= 2 ? TIER_ORDER[rank - 1] : null;
}

/**
 * Severity decides *how far* a category floors, not merely whether it does.
 *
 * - **STRONG** -> the category's full floor. "i've been cutting my arms" is a T4.
 * - **MODERATE** -> one tier below. A bare "self harm" with no first-person framing should
 *   put a human on the case within 24h (T3), not break-glass and lift a child's anonymity.
 * - **WEAK** -> nothing. It still moves the score, so the case can go grey and reach the
 *   conversation head, but "knife" in a food-tech story must not put a tier on a record.
 *
 * Modifiers take part in both passes regardless of their own severity, which is what keeps
 * "a threat with a time marker is imminent danger" working at both strengths.
 */
function floorFrom(hits: readonly GateHit[]): Tier | null {
  const modifiers = new Set(
    hits.filter((h) => GATE_MODIFIERS.has(h.category)).map((h) => h.category),
  );
  const strong = new Set(
    hits
      .filter((h) => h.severity === Severity.STRONG && !GATE_MODIFIERS.has(h.category))
      .map((h) => h.category),
  );
  const moderate = new Set(
    hits
      .filter((h) => h.severity === Severity.MODERATE && !GATE_MODIFIERS.has(h.category))
      .map((h) => h.category),
  );

  const candidates: Tier[] = [];
  if (strong.size > 0) {
    const hard = gateFloor(new Set([...strong, ...modifiers]));
    if (hard !== null) candidates.push(hard);
  }
  if (moderate.size > 0) {
    const soft = gateFloor(new Set([...moderate, ...modifiers]));
    if (soft !== null) {
      const demoted = demote(soft);
      if (demoted !== null) candidates.push(demoted);
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (tierRank(b) > tierRank(a) ? b : a));
}

/**
 * Unconstrained once the gate's own evidence justifies T4; otherwise capped at T3.
 *
 * Derived from the floor rather than recomputed from the hits, which is what stops the two
 * rules drifting apart. An earlier version computed the ceiling from "did a T4-capable
 * category fire" and immediately contradicted itself on "he said he'd stab me after
 * school": threat + time marker is a T4 floor by the locked promotion rule, but neither
 * category is T4-capable on its own.
 */
function ceilingFrom(floor: Tier | null): Tier | null {
  return floor === Tier.T4 ? null : CEILING_WITHOUT_T4;
}

/**
 * A modifier with nothing to modify is not a finding, so do not report it as one.
 *
 * Leaving the hit in the indicator list put `imminent_time_marker` on the escalation card
 * for seven synthetic conversations whose only sin was the word "tomorrow", which is
 * precisely the noise that trains a counsellor to stop reading the indicators.
 */
function dropOrphanModifiers(hits: GateHit[]): GateHit[] {
  if (hits.some((h) => !GATE_MODIFIERS.has(h.category))) return hits;
  return hits.filter((h) => !GATE_MODIFIERS.has(h.category));
}

function buildVerdict(rawHits: GateHit[], turnCount: number): SafetyVerdict {
  const hits = dropOrphanModifiers(rawHits);
  const value = score(hits);
  const floor = floorFrom(hits);
  const ceiling = ceilingFrom(floor);

  // True by construction now, and cheap. Left in because a future pattern or severity edit
  // is exactly the kind of change that would break it silently.
  if (floor !== null && ceiling !== null && tierRank(floor) > tierRank(ceiling)) {
    throw new Error(
      `gate emitted floor ${floor} above ceiling ${ceiling}; ` +
        "a floor rule and a ceiling rule have drifted apart",
    );
  }

  return {
    score: value,
    level: levelFor(value),
    indicators: hits,
    floor,
    ceiling,
    turnCount,
  };
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

/** Run the gate over a single student turn. This is the live-chat path. */
export function evaluateTurn(text: string, turnIndex = 0): SafetyVerdict {
  if (!text || !text.trim()) {
    return {
      score: 0.0,
      level: GateLevel.CLEAR,
      indicators: [],
      floor: null,
      ceiling: CEILING_WITHOUT_T4,
      turnCount: 1,
    };
  }
  return buildVerdict(hitsForTurn(text, turnIndex), 1);
}

/**
 * Run the gate over a whole transcript. This is the escalation-card path.
 *
 * Union of every turn's hits, then score once over the union. Scoring the union rather
 * than taking the max of per-turn scores is deliberate: a conversation with a weapon
 * mention in turn 2 and a time marker in turn 9 is imminent danger, and no single turn
 * contains both.
 */
export function evaluateConversation(turns: readonly string[]): SafetyVerdict {
  const hits: GateHit[] = [];
  turns.forEach((turn, i) => {
    if (turn && turn.trim()) hits.push(...hitsForTurn(turn, i));
  });
  return buildVerdict(hits, turns.length);
}

/**
 * Constrain a predicted tier by the gate. Returns `{ tier, reason }`.
 *
 * The **only** place floors and ceilings are applied. Ceiling first, then floor, so that
 * the floor is the last word and the invariant "no model output may lower a gate floor"
 * holds even if the two rules ever disagree.
 *
 * `t4Override` exists so a self-harm phrasing the banks never anticipated cannot be capped
 * into invisibility by the ceiling. It can only ever *raise* the outcome, and it is
 * recorded in the returned reason so the override shows up on the card.
 */
export function applyVerdict(
  predicted: Tier,
  verdict: SafetyVerdict,
  options: { t4Override?: boolean } = {},
): { tier: Tier; reason: string | null } {
  const { t4Override = false } = options;
  let tier = predicted;
  let reason: string | null = null;

  const ceiling = verdict.ceiling;
  if (ceiling !== null && tierRank(tier) > tierRank(ceiling)) {
    if (t4Override) {
      reason =
        `model proposed ${tier} above the gate ceiling ${ceiling}; ` +
        "allowed on strong calibrated self-harm evidence";
    } else {
      tier = ceiling;
      reason =
        `capped at ${ceiling}: no self-harm, abuse disclosure or imminent ` +
        "danger evidence in the transcript";
    }
  }

  const floored = applyFloor(tier, verdict.floor);
  if (floored !== tier) {
    const names = [
      ...new Set(
        verdict.indicators
          .filter((h) => hitWeight(h) >= config.GATE_FLOOR_MIN_WEIGHT)
          .map(describeHit),
      ),
    ].sort();
    reason = `floored to ${floored} by the safety gate: ${names.join(", ")}`;
    tier = floored;
  }

  return { tier, reason };
}

/** Re-exported so callers never need to reach past this module for the spec table. */
export { GATE_CATEGORIES, Tier, GateCategory };
