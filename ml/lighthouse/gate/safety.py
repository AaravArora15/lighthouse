"""The deterministic safety gate.

    from lighthouse.gate.safety import evaluate_turn, evaluate_conversation, apply_verdict

Runs **before** the conversational model on every student turn, and again over the whole
transcript when an escalation card is built. It emits floors and ceilings, never a final
decision. See ``docs/context.md`` section 6.

## Why this exists at all, given we trained a classifier

Three reasons, in order of how much they matter:

1. **It cannot fail.** No network, no API key, no model weights, no GPU. Regex on a string.
   When the Anthropic API is down or the classifier service times out
   (``config.CLASSIFIER_TIMEOUT_SECONDS``), this still returns a verdict, and a T4 verdict
   still puts real crisis numbers in front of the student. That is a product non-negotiable,
   not a nice-to-have.
2. **It is explainable line by line.** A counsellor asking "why was this escalated" gets
   `self_harm_intent / first_person_cutting` and the verbatim span that matched. A softmax
   over 6 classes cannot answer that question, and a school will ask it.
3. **It bounds the model rather than trusting it.** The classifier's worst measured error
   mode is distress vs self_harm (676 confusions on the day 2 test split). The gate does not
   fix that, but it means the unambiguous half of that boundary never depends on the model
   being right.

## The two invariants

* **No model output may lower a gate floor.** Enforced in exactly one place,
  :func:`apply_verdict`, via ``taxonomy.apply_floor``, and asserted in
  ``tests/test_safety.py`` over every synthetic conversation and a property sweep.
* **The gate never returns a tier.** It returns a floor, a ceiling and a score. Something
  else decides. If you ever find yourself wanting `verdict.tier`, you are about to break
  the thesis this whole project rests on.

## Scoring

Per category, take the highest-severity match (not the count: a student repeating "i want
to die" four times is not four times the risk, and rewarding repetition would make the
score a function of how much someone types). Combine categories with noisy-OR,
``1 - prod(1 - w)``, so independent moderate signals accumulate toward high without any
single one being able to exceed 1.0.

Modifiers (``imminent_time_marker``) contribute to the score only when a real category has
already fired. "See you tomorrow" is not a risk signal and must not tint the score.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Sequence

from lighthouse import config
from lighthouse.gate.patterns import (
    COMPILED_PATTERNS,
    COMPILED_SUPPRESSORS,
    SEVERITY_ORDER,
    Severity,
    normalize,
)
from lighthouse.taxonomy import (
    GATE_CATEGORIES,
    TIER_ORDER,
    GateCategory,
    Tier,
    apply_floor,
    gate_floor,
)

__all__ = [
    "GateLevel",
    "GateHit",
    "SafetyVerdict",
    "evaluate_turn",
    "evaluate_conversation",
    "apply_verdict",
]


class GateLevel(str, Enum):
    """Score band. Drives UI behaviour, not tier assignment."""

    CLEAR = "clear"
    GREY = "grey"
    """Uncertain. Does not floor. Marks the case for the conversation head and is a
    feature it consumes on day 4."""
    HIGH = "high"
    """Crisis resources render unconditionally, before any model output."""


SEVERITY_WEIGHT: dict[Severity, float] = {
    s: config.GATE_SEVERITY_WEIGHTS[s.value] for s in Severity
}

_CEILING_WITHOUT_T4 = Tier(config.GATE_CEILING_WITHOUT_T4_EVIDENCE)

_T4_CAPABLE = frozenset(
    c for c, spec in GATE_CATEGORIES.items() if spec.floor is Tier.T4
)
_MODIFIERS = frozenset(c for c, spec in GATE_CATEGORIES.items() if spec.is_modifier)


@dataclass(frozen=True)
class GateHit:
    """One pattern match, with enough provenance to justify it to a counsellor."""

    category: GateCategory
    severity: Severity
    pattern: str
    """The human-readable pattern name, e.g. ``first_person_cutting``. Never the regex."""
    turn_index: int
    span: tuple[int, int]
    """Offsets into the ORIGINAL turn text, not the normalised copy. ``patterns.normalize``
    is length-preserving precisely so this holds."""
    text: str
    """The verbatim matched substring. Quoted on the escalation card, so it must come from
    the original text and never from the normalised copy."""

    @property
    def weight(self) -> float:
        return SEVERITY_WEIGHT[self.severity]

    def describe(self) -> str:
        return f"{self.category.value} / {self.pattern}"


@dataclass(frozen=True)
class SafetyVerdict:
    """What the gate emits. Shape locked in ``docs/context.md`` section 6.

    Note what is absent: a tier. The gate constrains, it does not decide.
    """

    score: float
    level: GateLevel
    indicators: tuple[GateHit, ...]
    floor: Tier | None
    ceiling: Tier | None
    turn_count: int = 1

    @property
    def is_high(self) -> bool:
        return self.level is GateLevel.HIGH

    @property
    def is_grey(self) -> bool:
        return self.level is GateLevel.GREY

    @property
    def categories(self) -> tuple[GateCategory, ...]:
        """Fired categories, in taxonomy order. Deterministic across runs."""
        fired = {h.category for h in self.indicators}
        return tuple(c for c in GATE_CATEGORIES if c in fired)

    @property
    def indicator_names(self) -> tuple[str, ...]:
        """The ``gateIndicators`` field of the escalation card (context.md section 7)."""
        return tuple(c.value for c in self.categories)

    @property
    def requires_crisis_resources(self) -> bool:
        """Crisis numbers render on this, unconditionally and before any model output.

        Keyed off the T4 floor rather than off ``is_high``, because the two can diverge:
        a single STRONG threat plus a time marker scores 1.0 and floors at T4, while two
        MODERATE weapon hits score high without any self-harm or abuse evidence at all.
        The student-facing crisis card should follow the T4 floor.
        """
        return self.floor is Tier.T4

    def top_hits(self, limit: int = config.MAX_CITED_QUOTES) -> tuple[GateHit, ...]:
        """Highest-severity hits first, then earliest turn. What the card quotes."""
        ordered = sorted(
            self.indicators,
            key=lambda h: (-h.weight, h.turn_index, h.span[0]),
        )
        return tuple(ordered[:limit])

    def to_dict(self) -> dict:
        return {
            "score": round(self.score, 4),
            "level": self.level.value,
            "is_high": self.is_high,
            "is_grey": self.is_grey,
            "indicators": list(self.indicator_names),
            "floor": self.floor.value if self.floor else None,
            "ceiling": self.ceiling.value if self.ceiling else None,
            "hits": [
                {
                    "category": h.category.value,
                    "pattern": h.pattern,
                    "severity": h.severity.value,
                    "turn_index": h.turn_index,
                    "text": h.text,
                }
                for h in self.indicators
            ],
        }


# --------------------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------------------


def _variants(text: str) -> tuple[str, ...]:
    """The haystacks every pattern is run against: plain lowercase, and de-leetspeaked.

    Both, not just the normalised one. ``normalize`` maps digits to letters, so ``"5"``
    becomes ``"s"`` and every pattern that needs a digit stops working. That is exactly
    how ``"we walked 5 kms for the charity thing"`` got a T4 floor in testing: the
    ``distance_kms`` suppressor could no longer see the ``5``, so ``kms`` read as "kill
    myself". Searching both strings keeps leetspeak evasion caught without blinding the
    banks to digits. Spans are interchangeable because ``normalize`` is length-preserving.
    """
    lowered = text.lower()
    normalised = normalize(text)
    return (lowered,) if lowered == normalised else (lowered, normalised)


def _suppressed_spans(
    category: GateCategory, haystacks: Sequence[str]
) -> list[tuple[int, int]]:
    return [
        m.span()
        for _, rx in COMPILED_SUPPRESSORS[category]
        for haystack in haystacks
        for m in rx.finditer(haystack)
    ]


def _is_suppressed(span: tuple[int, int], suppressed: Iterable[tuple[int, int]]) -> bool:
    """True when the match sits inside a suppressor's span.

    Containment, not mere co-occurrence. ``"he told me to kill myself, and honestly i do
    want to die"`` must suppress the first clause and keep the second: an
    anywhere-in-the-text suppressor would throw away the disclosure that matters.
    """
    start, end = span
    return any(s <= start and end <= e for s, e in suppressed)


def _overlaps_any(span: tuple[int, int], taken: Iterable[tuple[int, int]]) -> bool:
    start, end = span
    return any(start < e and s < end for s, e in taken)


def _hits_for_turn(text: str, turn_index: int) -> list[GateHit]:
    haystacks = _variants(text)
    hits: list[GateHit] = []

    for category, bank in COMPILED_PATTERNS.items():
        suppressed = _suppressed_spans(category, haystacks)
        # Highest severity first, then drop any later match that overlaps one already
        # taken. Without this, "someone brought a knife to school" reports three separate
        # weapon_mention hits for one phrase, and the escalation card quotes the same
        # eight words three times. Severity order means the survivor is the strongest
        # reading, which is also the one worth showing.
        taken: list[tuple[int, int]] = []
        for severity in reversed(SEVERITY_ORDER):
            for name, rx in bank.get(severity, []):
                for haystack in haystacks:
                    for m in rx.finditer(haystack):
                        span = m.span()
                        if _overlaps_any(span, taken) or _is_suppressed(span, suppressed):
                            continue
                        taken.append(span)
                        hits.append(
                            GateHit(
                                category=category,
                                severity=severity,
                                pattern=name,
                                turn_index=turn_index,
                                span=span,
                                # Sliced from the ORIGINAL, so casing and leetspeak
                                # survive into the counsellor's view of what was written.
                                text=text[span[0] : span[1]],
                            )
                        )
    return hits


def _score(hits: Sequence[GateHit]) -> float:
    """Noisy-OR over per-category maxima. Modifiers only count alongside a real category."""
    per_category: dict[GateCategory, float] = {}
    for hit in hits:
        per_category[hit.category] = max(per_category.get(hit.category, 0.0), hit.weight)

    substantive = {c: w for c, w in per_category.items() if c not in _MODIFIERS}
    if not substantive:
        # Only modifiers fired. "after school" on its own is not a risk signal, and a gate
        # that greys out every conversation mentioning lunchtime is a gate nobody reads.
        return 0.0

    # Past this line a real category fired, so the modifier is allowed to contribute.
    product = 1.0
    for weight in per_category.values():
        product *= 1.0 - weight
    return 1.0 - product


def _level(score: float) -> GateLevel:
    if score >= config.GATE_HIGH_SCORE:
        return GateLevel.HIGH
    if score >= config.GATE_GREY_SCORE:
        return GateLevel.GREY
    return GateLevel.CLEAR


def _demote(tier: Tier) -> Tier | None:
    """One tier down. ``T1`` demotes to ``None``, i.e. no floor worth recording."""
    return TIER_ORDER[tier.rank - 1] if tier.rank >= 2 else None


def _floor_from(hits: Sequence[GateHit]) -> Tier | None:
    """Severity decides *how far* a category floors, not merely whether it does.

    This is the most consequential rule in the file, so it is spelled out rather than
    folded into ``taxonomy.gate_floor`` (which stays the single source of truth for what a
    *category* means, independent of how strongly it matched):

    * **STRONG** -> the category's full floor. ``"i've been cutting my arms"`` is a T4.
    * **MODERATE** -> one tier below. A bare ``"self harm"`` with no first-person framing
      should put a human on the case within 24h (T3), not break-glass and lift a child's
      anonymity (T4). The benign reading is live, so the response is proportionate to it.
    * **WEAK** -> nothing. It still moves the score, so the case can go grey and reach the
      conversation head, but the word "knife" in a food-tech story must not put a tier on
      anyone's record.

    Modifiers take part in both passes regardless of their own severity: severity grading
    is meaningless for ``imminent_time_marker``, which has exactly one family. That is what
    keeps the locked rule "a threat with a time marker is imminent danger" working at both
    strengths: STRONG threat + marker floors T4, MODERATE threat + marker floors T3.
    """
    modifiers = {h.category for h in hits if h.category in _MODIFIERS}
    strong = {
        h.category
        for h in hits
        if h.severity is Severity.STRONG and h.category not in _MODIFIERS
    }
    moderate = {
        h.category
        for h in hits
        if h.severity is Severity.MODERATE and h.category not in _MODIFIERS
    }

    candidates: list[Tier] = []
    if strong:
        hard = gate_floor(strong | modifiers)
        if hard is not None:
            candidates.append(hard)
    if moderate:
        soft = gate_floor(moderate | modifiers)
        if soft is not None:
            demoted = _demote(soft)
            if demoted is not None:
                candidates.append(demoted)

    return max(candidates, key=lambda t: t.rank) if candidates else None


def _ceiling_from(floor: Tier | None) -> Tier | None:
    """Unconstrained once the gate's own evidence justifies T4; otherwise capped at T3.

    Derived from the floor rather than recomputed from the hits, which is what stops the
    two rules from drifting apart. An earlier version computed the ceiling from
    "did a T4-capable category fire", and it immediately contradicted itself on
    ``"he said he'd stab me after school"``: threat + time marker is a T4 floor by the
    locked promotion rule, but neither category is T4-capable on its own.
    """
    return None if floor is Tier.T4 else _CEILING_WITHOUT_T4


def _drop_orphan_modifiers(hits: list[GateHit]) -> list[GateHit]:
    """A modifier with nothing to modify is not a finding, so do not report it as one.

    ``imminent_time_marker`` already contributes nothing to the score on its own. Leaving
    the hit in the indicator list anyway put ``imminent_time_marker`` on the escalation
    card for seven synthetic conversations whose only sin was the word "tomorrow", which
    is precisely the noise that trains a counsellor to stop reading the indicators.
    """
    if any(h.category not in _MODIFIERS for h in hits):
        return hits
    return [h for h in hits if h.category not in _MODIFIERS]


def _verdict(hits: list[GateHit], turn_count: int) -> SafetyVerdict:
    hits = _drop_orphan_modifiers(hits)
    score = _score(hits)
    floor = _floor_from(hits)
    ceiling = _ceiling_from(floor)

    # True by construction now, and cheap. Left in because a future pattern or severity
    # edit is exactly the kind of change that would break it silently.
    if floor is not None and ceiling is not None:
        assert floor.rank <= ceiling.rank, (
            f"gate emitted floor {floor.value} above ceiling {ceiling.value}; "
            "a floor rule and a ceiling rule have drifted apart"
        )

    return SafetyVerdict(
        score=score,
        level=_level(score),
        indicators=tuple(hits),
        floor=floor,
        ceiling=ceiling,
        turn_count=turn_count,
    )


# --------------------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------------------


def evaluate_turn(text: str, turn_index: int = 0) -> SafetyVerdict:
    """Run the gate over a single student turn. This is the live-chat path."""
    if not text or not text.strip():
        return SafetyVerdict(0.0, GateLevel.CLEAR, (), None, _CEILING_WITHOUT_T4, 1)
    return _verdict(_hits_for_turn(text, turn_index), turn_count=1)


def evaluate_conversation(turns: Sequence[str]) -> SafetyVerdict:
    """Run the gate over a whole transcript. This is the escalation-card path.

    Union of every turn's hits, then score once over the union. Scoring the union rather
    than taking the max of per-turn scores is deliberate: a conversation with a weapon
    mention in turn 2 and a time marker in turn 9 is imminent danger, and no single turn
    contains both.
    """
    hits: list[GateHit] = []
    for i, turn in enumerate(turns):
        if turn and turn.strip():
            hits.extend(_hits_for_turn(turn, i))
    return _verdict(hits, turn_count=len(turns))


def apply_verdict(
    predicted: Tier,
    verdict: SafetyVerdict,
    *,
    t4_override: bool = False,
) -> tuple[Tier, str | None]:
    """Constrain a predicted tier by the gate. Returns ``(tier, reason)``.

    The **only** place floors and ceilings are applied. Ceiling first, then floor, so that
    the floor is the last word and the invariant "no model output may lower a gate floor"
    holds even if the two rules ever disagree.

    ``t4_override`` exists so a self-harm phrasing the banks never anticipated cannot be
    capped into invisibility by the ceiling. Day 4 passes it when the calibrated
    conversation-level self-harm probability is high. It can only ever *raise* the outcome,
    and it is recorded in the returned reason so the override shows up on the card.
    """
    tier = predicted
    reason: str | None = None

    ceiling = verdict.ceiling
    if ceiling is not None and tier.rank > ceiling.rank:
        if t4_override:
            reason = (
                f"model proposed {tier.value} above the gate ceiling {ceiling.value}; "
                "allowed on strong calibrated self-harm evidence"
            )
        else:
            tier = ceiling
            reason = (
                f"capped at {ceiling.value}: no self-harm, abuse disclosure or imminent "
                "danger evidence in the transcript"
            )

    floored = apply_floor(tier, verdict.floor)
    if floored is not tier:
        names = ", ".join(
            sorted({h.describe() for h in verdict.indicators if h.weight >= config.GATE_FLOOR_MIN_WEIGHT})
        )
        reason = f"floored to {floored.value} by the safety gate: {names}"
        tier = floored

    return tier, reason


def main() -> None:
    """`python -m lighthouse.gate.safety "text"` — read a verdict without writing code."""
    import sys

    if len(sys.argv) < 2:
        sys.exit('usage: python -m lighthouse.gate.safety "some text"')
    verdict = evaluate_conversation(sys.argv[1:])
    print(json.dumps(verdict.to_dict(), indent=2))


if __name__ == "__main__":
    main()
