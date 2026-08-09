/**
 * The locked Lighthouse risk taxonomy — TypeScript mirror.
 *
 * This is a mirror of `ml/lighthouse/taxonomy.py`. Change both or neither; that rule is in
 * the root CLAUDE.md and it is not a style preference. The two runtimes decide the same
 * student's tier, and a drift between them is a safety bug that no test in either language
 * would catch on its own. `ml/tests/test_ts_conformance.py` is what actually holds them
 * together: it runs both gates over the same 80 conversations and diffs the verdicts.
 *
 * Locked 2026-08-04. See `docs/context.md` sections 5 and 6.
 */

export enum Tier {
  T0 = "T0",
  T1 = "T1",
  T2 = "T2",
  T3 = "T3",
  T4 = "T4",
}

/** Rank order. Index into this is the tier's rank, exactly as in the Python mirror. */
export const TIER_ORDER: readonly Tier[] = [
  Tier.T0,
  Tier.T1,
  Tier.T2,
  Tier.T3,
  Tier.T4,
] as const;

export function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

export interface TierSpec {
  readonly tier: Tier;
  readonly meaning: string;
  readonly action: string;
  /** null = no counsellor action; 0 = immediate. */
  readonly slaHours: number | null;
}

export const TIERS: Readonly<Record<Tier, TierSpec>> = {
  [Tier.T0]: {
    tier: Tier.T0,
    meaning: "General chat, no concern",
    action: "Log only",
    slaHours: null,
  },
  [Tier.T1]: {
    tier: Tier.T1,
    meaning: "Venting, mild social friction",
    action: "Log, no counsellor action",
    slaHours: null,
  },
  [Tier.T2]: {
    tier: Tier.T2,
    meaning: "Sustained bullying, exclusion, harassment",
    action: "Queue, routine",
    slaHours: 48,
  },
  [Tier.T3]: {
    tier: Tier.T3,
    meaning:
      "Severe or persistent harassment, threats, targeted discrimination, escalating distress",
    action: "Queue, priority",
    slaHours: 24,
  },
  [Tier.T4]: {
    tier: Tier.T4,
    meaning: "Self-harm intent, abuse disclosure, imminent danger",
    action: "Break-glass immediately, crisis resources to student",
    slaHours: 0,
  },
} as const;

/** Tiers that put a case in the counsellor queue. */
export const QUEUED_TIERS: ReadonlySet<Tier> = new Set([Tier.T2, Tier.T3, Tier.T4]);

/** Tiers that must never be auto-deleted by the retention job. */
export const ESCALATED_TIERS: ReadonlySet<Tier> = new Set([Tier.T3, Tier.T4]);

// ---------------------------------------------------------------------------------------
// Turn-level harm categories
// ---------------------------------------------------------------------------------------

/** What the DistilBERT turn classifier predicts. The web app only ever reads these. */
export enum Harm {
  NONE = "none",
  DISTRESS = "distress",
  HARASSMENT = "harassment",
  IDENTITY_ATTACK = "identity_attack",
  THREAT = "threat",
  SELF_HARM = "self_harm",
}

/** Order is load-bearing: it indexes the classifier's logit vector. */
export const HARM_ORDER: readonly Harm[] = [
  Harm.NONE,
  Harm.DISTRESS,
  Harm.HARASSMENT,
  Harm.IDENTITY_ATTACK,
  Harm.THREAT,
  Harm.SELF_HARM,
] as const;

// ---------------------------------------------------------------------------------------
// Deterministic safety gate categories
// ---------------------------------------------------------------------------------------

export enum GateCategory {
  SELF_HARM_INTENT = "self_harm_intent",
  SUICIDAL_IDEATION = "suicidal_ideation",
  ABUSE_DISCLOSURE = "abuse_disclosure",
  THREAT_OF_VIOLENCE = "threat_of_violence",
  WEAPON_MENTION = "weapon_mention",
  IMMINENT_TIME_MARKER = "imminent_time_marker",
}

export interface GateSpec {
  readonly category: GateCategory;
  /** Minimum tier this category forces. null means the category is a modifier only. */
  readonly floor: Tier | null;
  /** Modifiers do not floor on their own; they promote when co-occurring. */
  readonly isModifier: boolean;
  readonly note?: string;
}

/**
 * Insertion order matters and mirrors the Python dict. `SafetyVerdict.categories` reports
 * fired categories in this order so the escalation card renders deterministically.
 */
export const GATE_CATEGORY_ORDER: readonly GateCategory[] = [
  GateCategory.SELF_HARM_INTENT,
  GateCategory.SUICIDAL_IDEATION,
  GateCategory.ABUSE_DISCLOSURE,
  GateCategory.THREAT_OF_VIOLENCE,
  GateCategory.WEAPON_MENTION,
  GateCategory.IMMINENT_TIME_MARKER,
] as const;

export const GATE_CATEGORIES: Readonly<Record<GateCategory, GateSpec>> = {
  [GateCategory.SELF_HARM_INTENT]: {
    category: GateCategory.SELF_HARM_INTENT,
    floor: Tier.T4,
    isModifier: false,
  },
  [GateCategory.SUICIDAL_IDEATION]: {
    category: GateCategory.SUICIDAL_IDEATION,
    floor: Tier.T4,
    isModifier: false,
  },
  [GateCategory.ABUSE_DISCLOSURE]: {
    category: GateCategory.ABUSE_DISCLOSURE,
    floor: Tier.T4,
    isModifier: false,
  },
  [GateCategory.THREAT_OF_VIOLENCE]: {
    category: GateCategory.THREAT_OF_VIOLENCE,
    floor: Tier.T3,
    isModifier: false,
  },
  [GateCategory.WEAPON_MENTION]: {
    category: GateCategory.WEAPON_MENTION,
    floor: Tier.T3,
    isModifier: false,
  },
  [GateCategory.IMMINENT_TIME_MARKER]: {
    category: GateCategory.IMMINENT_TIME_MARKER,
    floor: null,
    isModifier: true,
    note:
      "Promotes a T3 floor to T4. A threat or weapon mention with an imminent time " +
      "marker ('tonight', 'tomorrow', 'after school') is imminent danger, which is the " +
      "definition of T4. Never floors on its own: a time marker in an otherwise " +
      "ordinary conversation is not a risk signal.",
  },
} as const;

/** Categories that can floor a case at T4 on their own. */
export const T4_CAPABLE: ReadonlySet<GateCategory> = new Set(
  GATE_CATEGORY_ORDER.filter((c) => GATE_CATEGORIES[c].floor === Tier.T4),
);

export const GATE_MODIFIERS: ReadonlySet<GateCategory> = new Set(
  GATE_CATEGORY_ORDER.filter((c) => GATE_CATEGORIES[c].isModifier),
);

/**
 * The tier floor implied by a set of fired gate categories.
 *
 * The only place the floor rule lives on this side of the wire. The invariant that no
 * model output may lower a gate floor is enforced by callers applying `applyFloor`.
 */
export function gateFloor(fired: Iterable<GateCategory>): Tier | null {
  const set = new Set(fired);
  if (set.size === 0) return null;

  const floors: Tier[] = [];
  for (const c of set) {
    const floor = GATE_CATEGORIES[c].floor;
    if (floor !== null) floors.push(floor);
  }
  // Only modifiers fired. A time marker alone is not a risk signal.
  if (floors.length === 0) return null;

  let floor = floors.reduce((a, b) => (tierRank(b) > tierRank(a) ? b : a));

  // A threat or weapon mention (T3) plus an imminent time marker is imminent danger,
  // which is T4 by definition. The marker never floors on its own: reaching this line
  // means some non-modifier category already fired.
  if (set.has(GateCategory.IMMINENT_TIME_MARKER) && floor === Tier.T3) {
    floor = Tier.T4;
  }
  return floor;
}

/** Raise `predicted` to `floor` if the gate demands it. Never lowers. */
export function applyFloor(predicted: Tier, floor: Tier | null): Tier {
  if (floor === null) return predicted;
  return tierRank(floor) > tierRank(predicted) ? floor : predicted;
}
