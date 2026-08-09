"""Offline tests for the conversation features and the tier head.

No torch, no checkpoint, no network. The turn probabilities come from the committed cache
at ``fixtures/synthetic_turn_probs.json``, which is exactly why that file is committed.

The model's *accuracy* is not asserted here. It is 80 synthetic conversations and the
number moves with the seed; pinning it would create a test that fails whenever someone adds
a conversation, which is the opposite of what we want to encourage. What is asserted is the
things that must hold regardless of how good the model is.
"""

from __future__ import annotations

import numpy as np
import pytest

from lighthouse import config
from lighthouse.data.synthetic import load, load_turn_probs
from lighthouse.gate.safety import apply_verdict, evaluate_conversation
from lighthouse.model import markers
from lighthouse.model.conversation_head import build_rows, queue_key
from lighthouse.model.features import (
    ABLATIONS,
    ALL_FEATURES,
    FEATURE_GROUPS,
    featurise,
    names_for,
    risk_series,
)
from lighthouse.taxonomy import HARM_ORDER, TIER_ORDER, Tier

ROWS = build_rows()
CONVERSATIONS = load()


# --------------------------------------------------------------------------------------
# The cache
# --------------------------------------------------------------------------------------


def test_cached_probabilities_cover_the_corpus_exactly() -> None:
    probs = load_turn_probs()
    for convo in CONVERSATIONS:
        assert len(probs[convo.id]) == len(convo.student_turns), convo.id


def test_cached_probabilities_are_probabilities() -> None:
    """A cache written from logits instead of softmax would still look plausible and would
    corrupt every feature downstream."""
    for convo_id, rows in load_turn_probs().items():
        for row in rows:
            assert len(row) == len(HARM_ORDER), convo_id
            assert all(0.0 <= p <= 1.0 for p in row), convo_id
            assert abs(sum(row) - 1.0) < 1e-3, f"{convo_id}: sums to {sum(row)}"


def test_day4_runs_without_torch_or_a_checkpoint(monkeypatch) -> None:
    """The point of the committed cache. If this fails, the ablation has quietly acquired a
    dependency on a 268MB artifact that is gitignored and cannot be reproduced from clone."""
    import sys

    monkeypatch.setitem(sys.modules, "torch", None)
    monkeypatch.setattr(config, "TURN_MODEL_DIR", config.ARTIFACTS_DIR / "does-not-exist")
    assert len(build_rows()) == 85


# --------------------------------------------------------------------------------------
# Features
# --------------------------------------------------------------------------------------


def test_every_declared_feature_is_produced() -> None:
    assert set(ROWS[0].features.values) == set(ALL_FEATURES)
    assert len(ALL_FEATURES) == len(set(ALL_FEATURES)), "duplicate feature name"


@pytest.mark.parametrize("row", ROWS, ids=[r.id for r in ROWS])
def test_all_features_are_finite(row) -> None:
    """A NaN slope from a short conversation trains silently and fails in production."""
    vector = row.features.vector(tuple(FEATURE_GROUPS))
    assert np.all(np.isfinite(vector)), row.id


def test_feature_vector_matches_the_declared_names() -> None:
    for name, groups in ABLATIONS.items():
        width = len(ROWS[0].features.vector(groups))
        assert width == len(names_for(groups)), name


def test_slope_is_zero_for_conversations_too_short_to_have_a_trend() -> None:
    verdict = evaluate_conversation(["hi"])
    probs = np.tile([0.9, 0.02, 0.02, 0.02, 0.02, 0.02], (2, 1))
    features = featurise(probs, verdict, ["hi", "bye"])
    assert features.values["trend_slope"] == 0.0
    assert features.values["n_turns"] == 2.0


def test_slope_is_positive_when_risk_climbs() -> None:
    """The feature `syn-050` and `syn-079` depend on, in isolation."""
    rising = np.array([[1 - r, r / 5, r / 5, r / 5, r / 5, r / 5] for r in
                       (0.05, 0.2, 0.5, 0.8, 0.95)])
    features = featurise(rising, evaluate_conversation([""]), [])
    assert features.values["trend_slope"] > 0.1
    assert features.values["second_half_delta"] > 0
    assert features.values["peak_position"] == 1.0


def test_slope_is_negative_when_risk_settles() -> None:
    falling = np.array([[1 - r, r / 5, r / 5, r / 5, r / 5, r / 5] for r in
                        (0.95, 0.8, 0.5, 0.2, 0.05)])
    features = featurise(falling, evaluate_conversation([""]), [])
    assert features.values["trend_slope"] < -0.1
    assert features.values["peak_position"] == 0.0


def test_risk_series_is_one_minus_p_none() -> None:
    probs = np.array([[0.7, 0.1, 0.1, 0.0, 0.0, 0.1]])
    assert risk_series(probs)[0] == pytest.approx(0.3)


def test_featurise_rejects_a_wrong_shape() -> None:
    with pytest.raises(ValueError):
        featurise(np.zeros((3, 4)), evaluate_conversation([""]), [])
    with pytest.raises(ValueError):
        featurise(np.zeros((0, len(HARM_ORDER))), evaluate_conversation([""]), [])


def test_history_group_is_inert_on_this_corpus() -> None:
    """Documented in `docs/results.md` as contributing nothing. If someone seeds
    multi-session data later, this test failing is the signal to update that claim."""
    assert all(
        row.features.values["prior_sessions"] == 0.0
        and row.features.values["prior_max_tier_rank"] == 0.0
        for row in ROWS
    )


# --------------------------------------------------------------------------------------
# Harm-report markers
# --------------------------------------------------------------------------------------


def test_markers_detect_duration() -> None:
    assert markers.extract(["it's been going on since september"]).duration_weeks >= 30
    assert markers.extract(["it started last week"]).duration_weeks <= 2
    assert markers.extract(["nothing has happened"]).duration_weeks == 0


def test_duration_score_is_bounded_and_monotonic() -> None:
    short = markers.extract(["it started last week"]).duration_score
    long = markers.extract(["it's been happening for two years"]).duration_score
    assert 0.0 <= short < long <= 1.0


def test_markers_detect_avoidance() -> None:
    """The strongest real-world signal, and the one described in entirely ordinary words."""
    found = markers.extract(["i've stopped putting my hand up entirely"])
    assert found.avoidance_hits
    assert not markers.extract(["i put my hand up in class today"]).avoidance_hits


def test_markers_detect_identity_targets_without_a_slur_present() -> None:
    """The whole point: the harm is named, the slur never appears."""
    for text in (
        "they keep saying things about where my family are from",
        "they've been taking my hijab off in the corridor",
        "people keep deadnaming me on purpose",
        "someone found out i'm gay and told the whole year",
        "they imitate my stammer every time i answer",
    ):
        assert markers.extract([text]).identity_hits, text


def test_accent_and_clothing_are_not_protected_characteristics() -> None:
    """`syn-031` (mocked for accent) and `syn-039` (mocked for trainers) are T2 in the
    taxonomy. If the identity marker fires on them, the T2/T3 boundary collapses."""
    assert not markers.extract(["people keep copying how i say things"]).identity_hits
    assert not markers.extract(["they say my trainers are fake"]).identity_hits


def test_markers_produce_counsellor_readable_descriptions() -> None:
    found = markers.extract([
        "it's been going on since september",
        "i've stopped going to lessons",
        "i haven't told anyone",
    ])
    described = found.describe()
    assert described
    assert all(isinstance(line, str) and line.strip() for line in described)


def test_markers_on_empty_input_are_all_zero() -> None:
    found = markers.extract([])
    assert all(value == 0.0 for value in found.values.values())


# --------------------------------------------------------------------------------------
# The queue, and the invariant that survives it
# --------------------------------------------------------------------------------------


def test_a_gate_floored_case_outranks_every_unfloored_one() -> None:
    """The queue's documented precedence. A model score must never outrank a T4 floor, or
    Monday's queue quietly violates the invariant the rest of the system enforces."""
    escalation = np.array([0.99, 0.01])
    floors = np.array([0, 4])
    keys = queue_key(escalation, floors)
    assert keys[1] > keys[0]


def test_queue_key_is_monotonic_in_the_model_score_within_a_floor() -> None:
    keys = queue_key(np.array([0.1, 0.5, 0.9]), np.array([3, 3, 3]))
    assert list(keys) == sorted(keys)


@pytest.mark.parametrize("row", ROWS, ids=[r.id for r in ROWS])
@pytest.mark.parametrize("predicted", TIER_ORDER)
def test_no_head_prediction_can_lower_a_gate_floor(row, predicted: Tier) -> None:
    """Day 3's invariant, re-asserted through the day 4 path. The head is now a real model
    producing real tiers, so this is no longer a hypothetical."""
    final, _ = apply_verdict(predicted, row.verdict)
    if row.verdict.floor is not None:
        assert final.rank >= row.verdict.floor.rank, row.id
    assert final.rank >= min(predicted.rank, final.rank)


def test_every_t4_conversation_survives_the_head_at_its_worst() -> None:
    """Even if the head predicted T0 on all sixteen, the product still returns T4."""
    for row in ROWS:
        if row.tier is Tier.T4:
            final, reason = apply_verdict(Tier.T0, row.verdict)
            assert final is Tier.T4, row.id
            assert reason


# --------------------------------------------------------------------------------------
# Corpus shape
# --------------------------------------------------------------------------------------


def test_rows_cover_the_corpus() -> None:
    assert len(ROWS) == 85
    assert {r.id for r in ROWS} == {c.id for c in CONVERSATIONS}


def test_gate_floors_only_ever_land_on_escalated_conversations() -> None:
    """Not a model property, a corpus property, and the reason floor-first queue ranking
    helps rather than hurts: on this corpus every floored case is a genuine T3 or T4."""
    for row in ROWS:
        if row.floor_rank > 0:
            assert row.tier in (Tier.T3, Tier.T4), f"{row.id} floored but is {row.tier}"
