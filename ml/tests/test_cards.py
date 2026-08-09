"""The escalation card, held to what it promises a counsellor.

A card is the only thing most counsellors will ever see of this system. If a quote is
paraphrased, or a queued case arrives with no evidence, or the gate floor silently drops,
the failure is invisible at the point of use — the card still *looks* authoritative.
These tests are what makes those failures loud.

Offline, like everything else: committed fixtures and a JSON weights file.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from lighthouse import config
from lighthouse.data.synthetic import load, load_turn_probs
from lighthouse.model import card as card_module
from lighthouse.model.card import OUTPUT, build_all, select_quotes
from lighthouse.model.predict import PARAMS_PATH, head
from lighthouse.taxonomy import ESCALATED_TIERS, QUEUED_TIERS, TIER_ORDER, Tier

pytestmark = pytest.mark.skipif(
    not PARAMS_PATH.exists(),
    reason="run `python -m lighthouse.model.predict --fit` first",
)

CONVERSATIONS = {c.id: c for c in load()}


@pytest.fixture(scope="module")
def cards():
    return build_all()


# ---------------------------------------------------------------------------------------
# The fixture must be current
# ---------------------------------------------------------------------------------------


def test_the_committed_cards_are_not_stale(cards) -> None:
    """The web console reads the committed fixture, not the live model.

    Precomputing is deliberate (context.md section 9: the demo must not depend on a
    sleeping HF Space). The cost is that a change to the gate, the features, or the head
    leaves the console serving cards from a system that no longer exists. This is the test
    that turns that into a build failure.
    """
    from dataclasses import asdict

    assert OUTPUT.exists(), (
        f"{OUTPUT.name} is missing. Run: python -m lighthouse.model.card --write"
    )
    committed = json.loads(OUTPUT.read_text())
    current = sorted((asdict(c) for c in cards), key=lambda c: -c["queueRank"])
    current = json.loads(json.dumps(current, sort_keys=True))

    if committed != current:
        changed = [
            c["caseId"]
            for c, d in zip(committed, current)
            if c != d
        ]
        pytest.fail(
            "fixtures/escalation_cards.json is out of date with the model.\n"
            f"cases that differ: {changed[:8]}\n"
            "Fix: python -m lighthouse.model.card --write"
        )


# ---------------------------------------------------------------------------------------
# Quotes are evidence
# ---------------------------------------------------------------------------------------


def test_every_quote_is_verbatim(cards) -> None:
    """A cited quote must appear character-for-character in a student turn.

    This is the property the whole citation chain exists to preserve, and it is why
    `patterns.normalize` is length-preserving: an offset computed during gate matching is
    used to slice the ORIGINAL text three layers later. A card that paraphrases is a card
    that cannot be trusted as evidence, and nothing about it would look wrong.
    """
    for card in cards:
        transcript = CONVERSATIONS[card.caseId].student_turns
        for quote in card.citedQuotes:
            assert any(quote["text"] in turn for turn in transcript), (
                f"{card.caseId}: quoted text is not present verbatim in any student "
                f"turn: {quote['text']!r}"
            )


def test_quotes_come_from_the_turn_they_claim(cards) -> None:
    for card in cards:
        transcript = CONVERSATIONS[card.caseId].student_turns
        for quote in card.citedQuotes:
            index = int(quote["turnId"].removeprefix("turn-"))
            assert 0 <= index < len(transcript), f"{card.caseId}: bad turn index {index}"
            assert quote["text"] in transcript[index], (
                f"{card.caseId}: quote attributed to turn {index} does not appear there"
            )


def test_the_quote_cap_holds(cards) -> None:
    for card in cards:
        assert len(card.citedQuotes) <= config.MAX_CITED_QUOTES


def test_the_student_is_never_quoted_from_the_assistants_words(cards) -> None:
    """The assistant says "crisis" and "safe" constantly. Quoting it back to a counsellor
    as if the student wrote it would be a fabrication, so only student turns are eligible."""
    for card in cards:
        convo = CONVERSATIONS[card.caseId]
        assistant = [t for role, t in convo.turns if role != "student"]
        for quote in card.citedQuotes:
            assert not any(quote["text"] in a for a in assistant if quote["text"]), (
                f"{card.caseId}: quoted the assistant, not the student"
            )


# ---------------------------------------------------------------------------------------
# A queued case must carry evidence
# ---------------------------------------------------------------------------------------


def test_every_queued_case_carries_evidence(cards) -> None:
    """A counsellor asked to action a case must be shown something the student wrote.

    T2 and most of T3 are gate-silent by design, and the victim-voice gap keeps their
    classifier scores below `CONCERN_THRESHOLD`, so the first version of `select_quotes`
    produced T3 cards with an empty evidence list. That is the one failure worse than a
    padded card.
    """
    empty = [c.caseId for c in cards if Tier(c.tier) in QUEUED_TIERS and not c.citedQuotes]
    assert not empty, f"queued cases with no cited evidence: {empty}"


def test_low_signal_quotes_are_labelled_honestly(cards) -> None:
    """The fallback quote says so. A counsellor reading "no explicit signal" knows to weigh
    it as context; the same sentence unlabelled would read as a finding."""
    for card in cards:
        for quote in card.citedQuotes:
            if quote["score"] < config.CONCERN_THRESHOLD and "/" not in quote["reason"]:
                assert "no explicit signal" in quote["reason"], (
                    f"{card.caseId}: a below-threshold quote is presented as a finding: "
                    f"{quote['reason']!r}"
                )


# ---------------------------------------------------------------------------------------
# The invariant
# ---------------------------------------------------------------------------------------


def test_no_card_sits_below_its_gate_floor(cards) -> None:
    """The one that would end the project if it broke.

    `predict_case` runs the model, then `apply_verdict`. If a card's tier were ever below
    the gate's floor for the same conversation, a model output would have lowered a floor.
    """
    for card in cards:
        verdict = CONVERSATIONS[card.caseId].verdict()
        if verdict.floor is None:
            continue
        assert Tier(card.tier).rank >= verdict.floor.rank, (
            f"{card.caseId}: card is {card.tier} but the gate floors at "
            f"{verdict.floor.value} — a model output lowered a gate floor"
        )


def test_every_t4_conversation_shows_crisis_resources(cards) -> None:
    for card in cards:
        verdict = CONVERSATIONS[card.caseId].verdict()
        assert card.crisisResourcesShown == verdict.requires_crisis_resources


def test_escalated_cases_are_exempt_from_retention(cards) -> None:
    """`ESCALATED_TIERS` must never be auto-deleted. Null, not a far-future date: "never"
    and "in 2099" are different promises and only one is true."""
    for card in cards:
        if Tier(card.tier) in ESCALATED_TIERS:
            assert card.retentionExpiresAt is None, f"{card.caseId} would be auto-deleted"
        else:
            assert card.retentionExpiresAt is not None


# ---------------------------------------------------------------------------------------
# Reasons
# ---------------------------------------------------------------------------------------


def test_the_reason_bank_covered_every_case(cards) -> None:
    assert not card_module.MISSES, (
        f"evidence with no reason template: {sorted(card_module.MISSES)}. "
        "Add one to _GATE_REASONS rather than letting the card render thinner."
    )


def test_every_card_states_a_reason(cards) -> None:
    for card in cards:
        assert card.reasons, f"{card.caseId} has no reasons at all"


def test_reasons_avoid_clinical_language(cards) -> None:
    """CLAUDE.md: never write copy that claims clinical capability. The reason bank is the
    likeliest place for it to creep in, because clinical words are compact."""
    banned = {"diagnos", "disorder", "symptom", "patient", "therapy", "treatment", "clinical"}
    for card in cards:
        for reason in card.reasons:
            lowered = reason.lower()
            hit = {w for w in banned if w in lowered}
            assert not hit, f"{card.caseId}: clinical language in a reason: {reason!r} {hit}"


# ---------------------------------------------------------------------------------------
# Queue ordering
# ---------------------------------------------------------------------------------------


def test_the_queue_puts_every_t4_above_every_non_escalated_case(cards) -> None:
    """`queueRank` is `floor_rank + escalation`, so a T4 floor outranks any model score.

    Checked against the non-escalated cases specifically: a T3 with an escalation
    probability of 1.0 legitimately sits adjacent to a T4, and demanding a strict global
    ordering would assert something the ranking never promised.
    """
    t4 = [c.queueRank for c in cards if c.tier == Tier.T4.value]
    routine = [c.queueRank for c in cards if Tier(c.tier) not in ESCALATED_TIERS]
    if t4 and routine:
        assert min(t4) > max(routine)


def test_predictions_are_deterministic() -> None:
    """Same conversation, same card. A queue that reordered between page loads would be
    unusable, and a fixture that changed on every regeneration would be unreviewable."""
    model = head()
    probs = load_turn_probs()
    convo = CONVERSATIONS["syn-066"]
    turn_probs = np.array(probs[convo.id])
    first = model.predict_case(turn_probs, convo.student_turns)
    second = model.predict_case(turn_probs, convo.student_turns)
    assert first.tier is second.tier
    assert first.confidence == second.confidence
    assert first.escalation == second.escalation


def test_selecting_quotes_never_exceeds_the_limit_even_with_many_hits() -> None:
    convo = CONVERSATIONS["syn-066"]
    quotes = select_quotes(
        convo.student_turns,
        np.array(load_turn_probs()[convo.id]),
        convo.verdict(),
        limit=config.MAX_CITED_QUOTES,
    )
    assert len(quotes) <= config.MAX_CITED_QUOTES


@pytest.mark.parametrize("tier", TIER_ORDER)
def test_every_tier_has_a_reason_template(tier: Tier) -> None:
    assert card_module._TIER_REASONS[tier]
