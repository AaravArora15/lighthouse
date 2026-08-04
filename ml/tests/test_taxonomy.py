"""Offline behaviour tests for the locked taxonomy and the gate floor rule.

No API key, no database, no network. These assert properties, not outputs: they are the
things that must stay true no matter what any model does.
"""

from __future__ import annotations

import itertools

import pytest

from lighthouse.taxonomy import (
    GATE_CATEGORIES,
    TIER_ORDER,
    GateCategory,
    Tier,
    apply_floor,
    gate_floor,
)

ALL_CATEGORIES = list(GateCategory)


# --------------------------------------------------------------------------------------
# The core invariant: no model output can lower a gate floor.
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("predicted", TIER_ORDER)
def test_apply_floor_never_lowers_a_tier(predicted: Tier) -> None:
    """Whatever the classifier says, applying a floor can only ever raise it."""
    for floor in [None, *TIER_ORDER]:
        result = apply_floor(predicted, floor)
        assert result.rank >= predicted.rank


def test_no_subset_of_gate_hits_can_lower_the_prediction() -> None:
    """Exhaustive over every possible combination of fired categories."""
    for r in range(len(ALL_CATEGORIES) + 1):
        for combo in itertools.combinations(ALL_CATEGORIES, r):
            floor = gate_floor(list(combo))
            for predicted in TIER_ORDER:
                assert apply_floor(predicted, floor).rank >= predicted.rank


def test_a_t4_gate_hit_forces_t4_even_from_t0() -> None:
    """The case that matters: the model says 'fine', the gate says self-harm."""
    for category in (
        GateCategory.SELF_HARM_INTENT,
        GateCategory.SUICIDAL_IDEATION,
        GateCategory.ABUSE_DISCLOSURE,
    ):
        floor = gate_floor([category])
        assert floor is Tier.T4
        assert apply_floor(Tier.T0, floor) is Tier.T4


# --------------------------------------------------------------------------------------
# The imminence modifier
# --------------------------------------------------------------------------------------


def test_imminent_time_marker_alone_never_floors() -> None:
    """'tomorrow' in an ordinary conversation is not a risk signal."""
    assert gate_floor([GateCategory.IMMINENT_TIME_MARKER]) is None
    assert apply_floor(Tier.T0, gate_floor([GateCategory.IMMINENT_TIME_MARKER])) is Tier.T0


@pytest.mark.parametrize(
    "category", [GateCategory.THREAT_OF_VIOLENCE, GateCategory.WEAPON_MENTION]
)
def test_imminence_promotes_a_t3_floor_to_t4(category: GateCategory) -> None:
    """A threat with a time on it is imminent danger, which is T4 by definition."""
    assert gate_floor([category]) is Tier.T3
    assert gate_floor([category, GateCategory.IMMINENT_TIME_MARKER]) is Tier.T4


def test_imminence_does_not_change_an_already_t4_floor() -> None:
    combo = [GateCategory.SUICIDAL_IDEATION, GateCategory.IMMINENT_TIME_MARKER]
    assert gate_floor(combo) is Tier.T4


# --------------------------------------------------------------------------------------
# General shape
# --------------------------------------------------------------------------------------


def test_empty_gate_produces_no_floor() -> None:
    assert gate_floor([]) is None
    assert apply_floor(Tier.T1, None) is Tier.T1


def test_floor_is_the_most_severe_of_the_fired_categories() -> None:
    combo = [GateCategory.THREAT_OF_VIOLENCE, GateCategory.ABUSE_DISCLOSURE]
    assert gate_floor(combo) is Tier.T4


def test_every_category_has_a_spec_and_modifiers_have_no_floor() -> None:
    for category in ALL_CATEGORIES:
        spec = GATE_CATEGORIES[category]
        assert spec.category is category
        if spec.is_modifier:
            assert spec.floor is None, "a modifier must not carry a floor of its own"
        else:
            assert spec.floor is not None


def test_tier_ordering_is_total_and_ascending() -> None:
    assert [t.rank for t in TIER_ORDER] == sorted(t.rank for t in TIER_ORDER)
    assert Tier.T0 < Tier.T1 < Tier.T2 < Tier.T3 < Tier.T4
