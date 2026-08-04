"""The locked Lighthouse risk taxonomy.

This module is the single source of truth for tiers, harm categories, and gate
categories. It is mirrored in TypeScript at ``web/src/lib/taxonomy.ts``; change both or
neither.

Locked on 2026-08-04. See ``docs/context.md`` sections 5 and 6. Do not add, remove, or
renumber tiers without updating the docs, the TS mirror, and the eval label mapping.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Tier(str, Enum):
    """Conversation-level risk tier. The classifier predicts exactly one of these."""

    T0 = "T0"
    T1 = "T1"
    T2 = "T2"
    T3 = "T3"
    T4 = "T4"

    @property
    def rank(self) -> int:
        return TIER_ORDER.index(self)

    def __lt__(self, other: "Tier") -> bool:  # type: ignore[override]
        return self.rank < other.rank

    def __le__(self, other: "Tier") -> bool:  # type: ignore[override]
        return self.rank <= other.rank


TIER_ORDER: list[Tier] = [Tier.T0, Tier.T1, Tier.T2, Tier.T3, Tier.T4]


@dataclass(frozen=True)
class TierSpec:
    tier: Tier
    meaning: str
    action: str
    sla_hours: int | None  # None = no counsellor action; 0 = immediate


TIERS: dict[Tier, TierSpec] = {
    Tier.T0: TierSpec(
        Tier.T0,
        "General chat, no concern",
        "Log only",
        None,
    ),
    Tier.T1: TierSpec(
        Tier.T1,
        "Venting, mild social friction",
        "Log, no counsellor action",
        None,
    ),
    Tier.T2: TierSpec(
        Tier.T2,
        "Sustained bullying, exclusion, harassment",
        "Queue, routine",
        48,
    ),
    Tier.T3: TierSpec(
        Tier.T3,
        "Severe or persistent harassment, threats, targeted discrimination, "
        "escalating distress",
        "Queue, priority",
        24,
    ),
    Tier.T4: TierSpec(
        Tier.T4,
        "Self-harm intent, abuse disclosure, imminent danger",
        "Break-glass immediately, crisis resources to student",
        0,
    ),
}

#: Tiers that put a case in the counsellor queue.
QUEUED_TIERS: frozenset[Tier] = frozenset({Tier.T2, Tier.T3, Tier.T4})

#: Tiers that must never be auto-deleted by the retention job.
ESCALATED_TIERS: frozenset[Tier] = frozenset({Tier.T3, Tier.T4})


# --------------------------------------------------------------------------------------
# Turn-level harm categories
# --------------------------------------------------------------------------------------


class Harm(str, Enum):
    """Turn-level harm label. What the DistilBERT turn classifier predicts.

    Deliberately coarser than the source datasets' label sets: the source labels are
    mapped onto these in ``lighthouse.data.mapping``. Keeping this small keeps the
    per-class support high enough for a usable macro-F1 on a 11-day timeline.
    """

    NONE = "none"
    """No harm. Ordinary conversation, including sad or negative but non-harmful talk."""

    DISTRESS = "distress"
    """First-person emotional distress without harm intent. Venting, hopelessness."""

    HARASSMENT = "harassment"
    """Generic bullying, insults, exclusion, mockery directed at a person."""

    IDENTITY_ATTACK = "identity_attack"
    """Harassment targeting a protected characteristic: race, religion, gender, sexuality."""

    THREAT = "threat"
    """Threat of violence or intimidation against a person."""

    SELF_HARM = "self_harm"
    """Self-harm or suicidal ideation, intent, plan, or disclosure."""


HARM_ORDER: list[Harm] = [
    Harm.NONE,
    Harm.DISTRESS,
    Harm.HARASSMENT,
    Harm.IDENTITY_ATTACK,
    Harm.THREAT,
    Harm.SELF_HARM,
]

HARM_TO_ID: dict[Harm, int] = {h: i for i, h in enumerate(HARM_ORDER)}
ID_TO_HARM: dict[int, Harm] = {i: h for h, i in HARM_TO_ID.items()}

#: Harm categories that carry no risk signal. Used for the "is this turn concerning" split.
BENIGN_HARMS: frozenset[Harm] = frozenset({Harm.NONE})


# --------------------------------------------------------------------------------------
# Deterministic safety gate categories
# --------------------------------------------------------------------------------------


class GateCategory(str, Enum):
    """Categories the deterministic safety gate can fire on.

    The gate runs BEFORE the conversational model and emits floors and ceilings, never a
    final decision. See ``docs/context.md`` section 6.
    """

    SELF_HARM_INTENT = "self_harm_intent"
    SUICIDAL_IDEATION = "suicidal_ideation"
    ABUSE_DISCLOSURE = "abuse_disclosure"
    THREAT_OF_VIOLENCE = "threat_of_violence"
    WEAPON_MENTION = "weapon_mention"
    IMMINENT_TIME_MARKER = "imminent_time_marker"


@dataclass(frozen=True)
class GateSpec:
    category: GateCategory
    floor: Tier | None
    """Minimum tier this category forces. None means the category is a modifier only."""
    is_modifier: bool = False
    """Modifiers do not floor on their own; they promote when co-occurring."""
    note: str = ""


GATE_CATEGORIES: dict[GateCategory, GateSpec] = {
    GateCategory.SELF_HARM_INTENT: GateSpec(
        GateCategory.SELF_HARM_INTENT, Tier.T4
    ),
    GateCategory.SUICIDAL_IDEATION: GateSpec(
        GateCategory.SUICIDAL_IDEATION, Tier.T4
    ),
    GateCategory.ABUSE_DISCLOSURE: GateSpec(
        GateCategory.ABUSE_DISCLOSURE, Tier.T4
    ),
    GateCategory.THREAT_OF_VIOLENCE: GateSpec(
        GateCategory.THREAT_OF_VIOLENCE, Tier.T3
    ),
    GateCategory.WEAPON_MENTION: GateSpec(
        GateCategory.WEAPON_MENTION, Tier.T3
    ),
    GateCategory.IMMINENT_TIME_MARKER: GateSpec(
        GateCategory.IMMINENT_TIME_MARKER,
        None,
        is_modifier=True,
        note=(
            "Promotes a T3 floor to T4. A threat or weapon mention with an imminent "
            "time marker ('tonight', 'tomorrow', 'after school') is imminent danger, "
            "which is the definition of T4. Never floors on its own: a time marker in "
            "an otherwise ordinary conversation is not a risk signal."
        ),
    ),
}

#: Categories that can floor a case at T4 on their own.
T4_CAPABLE: frozenset[GateCategory] = frozenset(
    c for c, spec in GATE_CATEGORIES.items() if spec.floor is Tier.T4
)


def gate_floor(fired: list[GateCategory] | set[GateCategory]) -> Tier | None:
    """Return the tier floor implied by a set of fired gate categories.

    This is the only place the floor rule lives. The invariant that no model output may
    lower a gate floor is enforced by the caller applying ``max(predicted, gate_floor)``
    over :data:`TIER_ORDER`, and is asserted in the offline behaviour tests.
    """
    fired = set(fired)
    if not fired:
        return None

    floors = [
        GATE_CATEGORIES[c].floor
        for c in fired
        if GATE_CATEGORIES[c].floor is not None
    ]
    if not floors:
        # Only modifiers fired. A time marker alone is not a risk signal.
        return None

    floor = max(floors, key=lambda t: t.rank)

    # A threat or weapon mention (T3) plus an imminent time marker is imminent danger,
    # which is T4 by definition. The marker never floors on its own: reaching this line
    # means some non-modifier category already fired.
    if GateCategory.IMMINENT_TIME_MARKER in fired and floor is Tier.T3:
        floor = Tier.T4

    return floor


def apply_floor(predicted: Tier, floor: Tier | None) -> Tier:
    """Raise ``predicted`` to ``floor`` if the gate demands it. Never lowers."""
    if floor is None:
        return predicted
    return floor if floor.rank > predicted.rank else predicted
