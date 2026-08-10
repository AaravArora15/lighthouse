"""Offline behaviour tests for the deterministic safety gate.

No API key, no database, no network, no model weights. Everything here is a property that
must hold on a laptop with the wifi off, because that is the situation the gate exists for.

``test_taxonomy.py`` covers the floor *rule* in the abstract. This file covers the gate
that produces the inputs to that rule, and the two places the rule is actually applied.

The tests are grouped by what they protect, not by what they call. If one fails, the
comment above it should tell you which product promise just broke.
"""

from __future__ import annotations

import itertools
import re

import pytest

from lighthouse import config
from lighthouse.gate.patterns import (
    COMPILED_PATTERNS,
    COMPILED_SUPPRESSORS,
    PATTERNS,
    SUPPRESSORS,
    Severity,
    normalize,
)
from lighthouse.gate.safety import (
    GateLevel,
    SafetyVerdict,
    apply_verdict,
    evaluate_conversation,
    evaluate_turn,
)
from lighthouse.taxonomy import TIER_ORDER, GateCategory, Tier


# --------------------------------------------------------------------------------------
# NON-NEGOTIABLE 1: no model output may lower a gate floor.
# --------------------------------------------------------------------------------------
#
# CLAUDE.md, verbatim: "The deterministic safety gate runs before the conversational model,
# and emits floors and ceilings, never a final decision. No model output may lower a gate
# floor." Everything in this section is that sentence, executable.

FLOORING_TEXTS = [
    "i want to kill myself",
    "i've been cutting my arms again",
    "my dad hits me when he's been drinking",
    "he said he'd stab me after school",
    "someone brought a knife to school",
    "i left a goodbye letter",
    "im not safe at home",
    "everyone would be better off without me",
    "there's a lot of self harm content on that app",
    "im scared to go home tonight",
]


@pytest.mark.parametrize("text", FLOORING_TEXTS)
@pytest.mark.parametrize("predicted", TIER_ORDER)
def test_no_prediction_can_lower_a_gate_floor(text: str, predicted: Tier) -> None:
    """The whole product rests on this. Every flooring text, against every tier a model
    could possibly return, including a confident T0."""
    verdict = evaluate_turn(text)
    assert verdict.floor is not None, f"expected a floor for {text!r}"

    final, reason = apply_verdict(predicted, verdict)
    assert final.rank >= verdict.floor.rank, (
        f"gate floor {verdict.floor.value} was lowered to {final.value} "
        f"by a model prediction of {predicted.value}"
    )
    if verdict.floor.rank > predicted.rank:
        assert reason is not None, "a floor that changed the tier must be explained"


@pytest.mark.parametrize("text", FLOORING_TEXTS)
@pytest.mark.parametrize("predicted", TIER_ORDER)
def test_the_t4_override_cannot_lower_a_floor_either(text: str, predicted: Tier) -> None:
    """The one documented escape hatch is one-directional. It exists to let strong
    classifier evidence break *through* a ceiling, never to relax a floor."""
    verdict = evaluate_turn(text)
    final, _ = apply_verdict(predicted, verdict, t4_override=True)
    assert final.rank >= verdict.floor.rank  # type: ignore[union-attr]


def test_a_confident_benign_prediction_still_gets_crisis_resources() -> None:
    """The concrete failure this prevents: the classifier reads a suicide note as ordinary
    sadness (its measured worst error mode is exactly this boundary) and the student sees
    nothing."""
    verdict = evaluate_turn("i don't want to be here any more, i'm going to end it all")
    assert verdict.floor is Tier.T4
    assert verdict.requires_crisis_resources

    final, reason = apply_verdict(Tier.T0, verdict)
    assert final is Tier.T4
    assert reason and "floored" in reason


# --------------------------------------------------------------------------------------
# NON-NEGOTIABLE 2: crisis resources are unconditional on a T4 gate hit.
# --------------------------------------------------------------------------------------


def test_crisis_resources_follow_the_t4_floor_not_the_score() -> None:
    """These two genuinely diverge, and the student-facing card must follow the floor.

    A weapon mention can score 1.00 (high) with no self-harm evidence anywhere: that is a
    counsellor's problem, not a moment to hand a child a crisis line. A grey-scoring
    self-harm disclosure is the reverse.
    """
    weapon = evaluate_turn("he had a knife in his bag")
    assert weapon.is_high
    assert not weapon.requires_crisis_resources

    self_harm = evaluate_turn("i want to kill myself")
    assert self_harm.requires_crisis_resources


def test_crisis_decision_needs_no_model_no_network_and_no_key(monkeypatch) -> None:
    """Strip every credential from the environment and confirm the gate is unmoved."""
    for var in ("ANTHROPIC_API_KEY", "HF_TOKEN", "DATABASE_URL", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    verdict = evaluate_turn("i want to kill myself")
    assert verdict.requires_crisis_resources


def test_gate_module_imports_nothing_that_can_reach_the_network() -> None:
    """A guard against someone 'improving' the gate with an API call later. If this fails,
    the gate stopped being the thing that works when everything else is down."""
    import lighthouse.gate.patterns as patterns_module
    import lighthouse.gate.safety as safety_module

    banned = {
        "requests", "httpx", "urllib", "urllib3", "socket", "aiohttp",
        "anthropic", "openai", "torch", "transformers", "sklearn", "psycopg",
    }
    for module in (safety_module, patterns_module):
        bound = {
            value.__name__.split(".")[0]
            for value in vars(module).values()
            if type(value).__name__ == "module"
        }
        offenders = banned & bound
        assert not offenders, f"{module.__name__} pulls in {offenders}"


# --------------------------------------------------------------------------------------
# The gate never returns a tier.
# --------------------------------------------------------------------------------------


def test_the_verdict_has_no_tier_field() -> None:
    """If this ever fails, someone has given the gate the power to decide, and the
    "classifier decides, LLM explains, gate constrains" split has collapsed."""
    verdict = evaluate_turn("i want to kill myself")
    assert not hasattr(verdict, "tier")
    assert set(verdict.to_dict()) == {
        "score", "level", "is_high", "is_grey", "indicators", "floor", "ceiling", "hits",
    }


# --------------------------------------------------------------------------------------
# Grading: severity decides how far a category floors.
# --------------------------------------------------------------------------------------


def test_weak_matches_never_floor() -> None:
    """"knife" in a story about a kitchen drawer must not put a tier on a child's record."""
    verdict = evaluate_turn("the knife is in the drawer")
    assert verdict.indicators, "the weak match should still be recorded"
    assert all(h.severity is Severity.WEAK for h in verdict.indicators)
    assert verdict.floor is None
    assert verdict.level is GateLevel.CLEAR


def test_a_weak_match_is_still_visible_to_the_conversation_head() -> None:
    """Not flooring is not the same as being invisible. Two weak signals reach grey."""
    verdict = evaluate_turn("i saw a blade in his bag, there was a weapon at school")
    assert verdict.score > 0
    assert verdict.indicators


def test_moderate_matches_floor_one_tier_below_the_category() -> None:
    """A bare topic mention gets a counsellor within 24h, not a break-glass."""
    verdict = evaluate_turn("there's a lot of self harm content on that app")
    assert [h.severity for h in verdict.indicators] == [Severity.MODERATE]
    assert verdict.floor is Tier.T3  # the category itself floors at T4
    assert not verdict.requires_crisis_resources


def test_strong_matches_floor_at_the_full_category_tier() -> None:
    verdict = evaluate_turn("i've been cutting my arms again")
    assert any(h.severity is Severity.STRONG for h in verdict.indicators)
    assert verdict.floor is Tier.T4


# --------------------------------------------------------------------------------------
# The imminence modifier, end to end through the real patterns.
# --------------------------------------------------------------------------------------


def test_a_time_marker_alone_scores_zero() -> None:
    """A gate that greys out every conversation mentioning lunchtime is a gate nobody
    reads, and an ignored gate is a broken one."""
    for text in ("see you tomorrow!", "we've got a test after school", "call me tonight"):
        verdict = evaluate_turn(text)
        assert verdict.score == 0.0, text
        assert verdict.floor is None, text
        assert verdict.level is GateLevel.CLEAR, text


def test_a_threat_with_a_time_marker_is_imminent_danger() -> None:
    plain = evaluate_turn("im going to batter you")
    timed = evaluate_turn("im going to batter you tomorrow")
    assert plain.floor is Tier.T3
    assert timed.floor is Tier.T4
    assert timed.requires_crisis_resources


def test_imminence_promotion_survives_across_turns() -> None:
    """The reason the conversation-level gate scores the union of hits rather than taking
    the max of per-turn scores: no single turn here contains both halves."""
    turns = [
        "hey",
        "someone brought a knife to school",
        "idk what to do",
        "he's waiting for me after school",
    ]
    assert evaluate_turn(turns[1]).floor is Tier.T3
    assert evaluate_conversation(turns).floor is Tier.T4


# --------------------------------------------------------------------------------------
# Suppressors. Each of these was a live false positive before the suppressor existed.
# --------------------------------------------------------------------------------------

SUPPRESSED = [
    ("idiom", "this homework is killing me"),
    ("idiom", "i could kill for a coffee right now"),
    ("negation", "i would never kill myself"),
    ("negation", "i'm not suicidal, i just feel flat"),
    ("negation", "i'm not going to hurt myself, i promise"),
    ("topic", "we're reading a book about suicide for english"),
    ("topic", "it's suicide prevention week at school"),
    ("recovery", "i stopped cutting last year"),
    ("context", "we used a butter knife in food tech"),
    ("context", "i'm gonna smash you at fifa later"),
    ("digits", "we walked 5 kms for the charity thing"),
    ("play", "my brother was play fighting and hit me"),
]


@pytest.mark.parametrize("kind,text", SUPPRESSED, ids=[f"{k}:{t[:24]}" for k, t in SUPPRESSED])
def test_suppressors_prevent_a_floor(kind: str, text: str) -> None:
    verdict = evaluate_turn(text)
    assert verdict.floor is None, (
        f"{kind} false positive: {text!r} floored at "
        f"{verdict.floor.value if verdict.floor else None} via "
        f"{[h.describe() for h in verdict.indicators]}"
    )


def test_suppression_is_scoped_to_the_clause_not_the_whole_turn() -> None:
    """The single most important suppressor test. A student can report being told to kill
    themselves *and* disclose their own intent in the same breath, and an
    anywhere-in-the-text suppressor would throw the second half away."""
    verdict = evaluate_turn("he told me to kill myself, and honestly i do want to die")
    categories = set(verdict.categories)
    assert GateCategory.THREAT_OF_VIOLENCE in categories, "the harassment must be recorded"
    assert GateCategory.SUICIDAL_IDEATION in categories, "the disclosure must survive"
    assert verdict.floor is Tier.T4
    assert verdict.requires_crisis_resources


def test_being_told_to_kill_yourself_is_harassment_not_self_disclosure() -> None:
    """Severe harassment, so it floors. But it is not the student's own intent, so it must
    not break glass and lift their anonymity."""
    verdict = evaluate_turn("everyone keeps telling me to kys")
    assert verdict.categories == (GateCategory.THREAT_OF_VIOLENCE,)
    assert verdict.floor is Tier.T3
    assert not verdict.requires_crisis_resources


def test_a_disclosure_about_a_friend_is_visible_but_does_not_break_glass() -> None:
    """Regression: an early version suppressed this outright and it scored 0.00, which
    made a real child at real risk invisible."""
    verdict = evaluate_turn("my friend said she wants to die and i'm scared")
    assert verdict.indicators
    assert verdict.floor is Tier.T3
    assert not verdict.requires_crisis_resources


# --------------------------------------------------------------------------------------
# Obfuscation.
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    ["k!ll myself", "im gonna k1ll myself tonight", "KYS", "i want to un4live myself"],
)
def test_leetspeak_does_not_evade_the_gate(text: str) -> None:
    assert evaluate_turn(text).floor is not None, text


def test_normalize_is_length_preserving() -> None:
    """Load-bearing: match spans are reported against the ORIGINAL text so the escalation
    card can quote a student verbatim. A normaliser that changed length would silently
    shift every offset and the card would quote the wrong words."""
    for text in [
        "K!LL MYSELF", "we walked 5 kms", "", "   ", "a" * 500,
        "im gonna k1ll myself t0night!!!", "élan vital", "emoji 🙂 test",
    ]:
        assert len(normalize(text)) == len(text), repr(text)


def test_reported_spans_slice_the_original_text() -> None:
    """The quote on the card must be what the student typed, not the normalised copy."""
    text = "Honestly I've been CUTTING my arms again and I can't stop"
    verdict = evaluate_turn(text)
    assert verdict.indicators
    for hit in verdict.indicators:
        assert text[hit.span[0] : hit.span[1]] == hit.text
        assert hit.text in text


# --------------------------------------------------------------------------------------
# The ceiling.
# --------------------------------------------------------------------------------------


def test_a_clear_conversation_is_capped_below_break_glass() -> None:
    """T4 means break-glass, and break-glass means lifting a child's anonymity. Doing that
    on a transcript with no self-harm, no abuse and no imminent danger is a harm in
    itself, and it is the failure mode that gets the tool switched off by a school."""
    verdict = evaluate_conversation(["nobody talks to me at lunch anymore", "it's rubbish"])
    assert verdict.ceiling is Tier.T3

    final, reason = apply_verdict(Tier.T4, verdict)
    assert final is Tier.T3
    assert reason and "capped" in reason


def test_the_ceiling_lifts_once_the_gate_has_t4_evidence() -> None:
    verdict = evaluate_turn("i want to kill myself")
    assert verdict.ceiling is None
    final, _ = apply_verdict(Tier.T4, verdict)
    assert final is Tier.T4


def test_the_override_lets_strong_classifier_evidence_through_the_ceiling() -> None:
    """So a phrasing the regex banks never anticipated cannot be capped into invisibility.
    The override is recorded, because an unexplained escalation is not auditable."""
    verdict = evaluate_conversation(["everything feels grey and far away", "i'm just done"])
    assert verdict.ceiling is Tier.T3

    capped, _ = apply_verdict(Tier.T4, verdict)
    assert capped is Tier.T3

    allowed, reason = apply_verdict(Tier.T4, verdict, t4_override=True)
    assert allowed is Tier.T4
    assert reason is not None and "allowed" in reason, (
        "an override that lifts a ceiling must say so, or the escalation is unauditable"
    )


def test_the_ceiling_never_sits_below_the_floor() -> None:
    """Exhaustive over the real banks, not over synthetic category sets: the two rules are
    computed separately, and this is where they would drift apart."""
    for text in FLOORING_TEXTS + [t for _, t in SUPPRESSED]:
        verdict = evaluate_turn(text)
        if verdict.floor is not None and verdict.ceiling is not None:
            assert verdict.floor.rank <= verdict.ceiling.rank, text


def test_apply_verdict_is_monotonic_in_the_prediction() -> None:
    """A higher prediction can never produce a lower final tier. Exhaustive over every
    tier pair and every flooring text."""
    for text in FLOORING_TEXTS:
        verdict = evaluate_turn(text)
        outcomes = [apply_verdict(t, verdict)[0].rank for t in TIER_ORDER]
        assert outcomes == sorted(outcomes), text


# --------------------------------------------------------------------------------------
# Scoring.
# --------------------------------------------------------------------------------------


def test_score_bands_match_the_documented_arithmetic() -> None:
    """config.GATE_SEVERITY_WEIGHTS claims specific band boundaries. Hold it to them."""
    strong = config.GATE_SEVERITY_WEIGHTS["strong"]
    moderate = config.GATE_SEVERITY_WEIGHTS["moderate"]
    weak = config.GATE_SEVERITY_WEIGHTS["weak"]

    assert strong >= config.GATE_HIGH_SCORE
    assert config.GATE_GREY_SCORE <= moderate < config.GATE_HIGH_SCORE
    assert weak < config.GATE_GREY_SCORE
    assert 1 - (1 - moderate) ** 2 >= config.GATE_HIGH_SCORE, "two moderates should reach high"
    assert config.GATE_GREY_SCORE <= 1 - (1 - weak) ** 2 < config.GATE_HIGH_SCORE


def test_repetition_does_not_inflate_the_score() -> None:
    """Otherwise the score becomes a function of how much a student types, and a distressed
    child who repeats themselves outranks a calm one who says it once."""
    once = evaluate_turn("i want to kill myself")
    many = evaluate_turn("i want to kill myself. i want to kill myself. i want to kill myself")
    assert once.score == many.score


def test_score_is_bounded() -> None:
    everything = evaluate_conversation(FLOORING_TEXTS)
    assert 0.0 <= everything.score <= 1.0


def test_empty_and_whitespace_input_is_clear() -> None:
    for text in ("", "   ", "\n\t"):
        verdict = evaluate_turn(text)
        assert verdict.score == 0.0
        assert verdict.level is GateLevel.CLEAR
        assert verdict.floor is None
        assert verdict.indicators == ()


def test_evaluating_a_conversation_of_blanks_is_clear() -> None:
    verdict = evaluate_conversation(["", "  ", ""])
    assert verdict.level is GateLevel.CLEAR
    assert verdict.turn_count == 3


# --------------------------------------------------------------------------------------
# Determinism and output shape.
# --------------------------------------------------------------------------------------


def test_the_gate_is_deterministic() -> None:
    """It has to be. A counsellor challenging an escalation must be able to reproduce it,
    and the day 9 demo seeds precomputed scores that have to match a live rerun."""
    text = "he said he'd stab me after school and i've been cutting again"
    first = evaluate_turn(text)
    for _ in range(5):
        again = evaluate_turn(text)
        assert again.to_dict() == first.to_dict()


def test_indicator_names_are_stable_and_ordered() -> None:
    """gateIndicators on the escalation card. Set iteration order must not leak in."""
    verdict = evaluate_turn("he said he'd stab me after school")
    assert verdict.indicator_names == tuple(sorted(
        verdict.indicator_names,
        key=lambda n: list(GateCategory).index(GateCategory(n)),
    ))


def test_top_hits_respects_the_quote_cap() -> None:
    verdict = evaluate_conversation(FLOORING_TEXTS)
    assert len(verdict.top_hits()) <= config.MAX_CITED_QUOTES
    weights = [h.weight for h in verdict.top_hits()]
    assert weights == sorted(weights, reverse=True)


def test_turn_indices_point_at_the_right_turn() -> None:
    turns = ["hi", "nothing much", "i've been cutting my arms again"]
    verdict = evaluate_conversation(turns)
    assert verdict.indicators
    for hit in verdict.indicators:
        assert hit.turn_index == 2
        assert turns[hit.turn_index][hit.span[0] : hit.span[1]] == hit.text


# --------------------------------------------------------------------------------------
# Bank hygiene.
# --------------------------------------------------------------------------------------


def test_every_gate_category_has_a_bank() -> None:
    assert set(PATTERNS) == set(GateCategory)
    assert set(SUPPRESSORS) == set(GateCategory)


def test_every_pattern_compiles_and_is_uniquely_named() -> None:
    for category, bank in PATTERNS.items():
        names: list[str] = []
        for severity, entries in bank.items():
            for name, rx in entries:
                re.compile(rx)  # raises on a malformed pattern
                names.append(name)
        assert len(names) == len(set(names)), f"duplicate pattern name in {category.value}"


def test_no_pattern_matches_the_empty_string() -> None:
    """A pattern that matches "" fires on every turn ever sent, which would floor the
    entire corpus. Easy to write by accident with an all-optional group."""
    for category, bank in COMPILED_PATTERNS.items():
        for severity, entries in bank.items():
            for name, rx in entries:
                assert not rx.match(""), f"{category.value}/{name} matches the empty string"
    for category, entries in COMPILED_SUPPRESSORS.items():
        for name, rx in entries:
            assert not rx.match(""), f"suppressor {category.value}/{name} matches empty"


def test_no_pattern_fires_on_ordinary_school_chat() -> None:
    """The gate's precision budget. If it cries wolf on these, counsellors stop reading it
    and the whole triage layer is decoration."""
    benign = [
        "hey, are you there?",
        "i've got a maths test tomorrow and i haven't revised at all",
        "my mum said i can go to the cinema on saturday",
        "we lost the football match 4-0, it was so embarrassing",
        "i fell out with my best friend over something stupid",
        "i'm knackered, didn't sleep well",
        "our teacher gave us so much homework this week",
        "i'm nervous about the school trip",
        "do you know when the library opens?",
        "someone nicked my pencil case again lol",
        "i got told off for being late twice this week",
        "the wifi at school is so slow",
    ]
    for text in benign:
        verdict = evaluate_turn(text)
        assert verdict.floor is None, (
            f"false positive on ordinary chat: {text!r} -> "
            f"{[h.describe() for h in verdict.indicators]}"
        )
        assert verdict.level is GateLevel.CLEAR, text


def test_modifier_category_carries_exactly_one_severity() -> None:
    """Grading a modifier is meaningless: "tonight" is not more imminent than "after
    school" in any way we can measure, and pretending otherwise invites a fake threshold."""
    bank = PATTERNS[GateCategory.IMMINENT_TIME_MARKER]
    assert len(bank) == 1


# =========================================================================================
# LOCKED DECISION: moderate-severity suicidal ideation floors at T3, not T4.
#
# Reviewed on 2026-08-10 after `"i dont want to be alive anymore"` was found to be
# recognised as `suicidal_ideation` and yet show the student no crisis resources. The
# behaviour was kept deliberately, and these tests exist so it stays a *decision* rather
# than drifting into an accident in either direction.
#
# Why it was kept: `floor_from` demotes MODERATE matches one tier, and the same pattern
# bank catches `"whats the point of any of this"`, which is frequently about homework. A
# red crisis banner on that desensitises students to the real ones.
#
# What it costs: a student using indirect phrasing is queued for counsellor contact within
# 24 hours but is shown no helpline numbers in the moment. Stated in `docs/results.md` §5
# and in the README rather than hidden.
#
# If anyone later decides to close this gap, the intended route is a quieter support block
# for the grey band using `SUPPORT_RESOURCES`, NOT promoting these patterns to STRONG.
# =========================================================================================

INDIRECT_IDEATION = [
    "i dont want to be here anymore",
    "i don't want to be here anymore",
    "i dont want to be alive anymore",
    "whats the point of any of this",
]

EXPLICIT_IDEATION = [
    "i want to kill myself",
    "i have been cutting my arms",
    "i've been cutting my arms",
]


@pytest.mark.parametrize("text", INDIRECT_IDEATION)
def test_indirect_ideation_is_recognised_but_floors_at_t3(text):
    """The category fires. The floor is T3. Both halves are the decision."""
    verdict = evaluate_conversation([text])
    assert GateCategory.SUICIDAL_IDEATION in verdict.categories, (
        f"{text!r} should still be recognised as suicidal ideation"
    )
    assert verdict.floor is Tier.T3, (
        f"{text!r} floored at {verdict.floor}, expected T3. If this was intentional, "
        "update the locked-decision block above and docs/results.md §5."
    )


@pytest.mark.parametrize("text", INDIRECT_IDEATION)
def test_indirect_ideation_shows_no_crisis_resources(text):
    """The consequence, asserted directly rather than left implicit in the floor."""
    assert not evaluate_conversation([text]).requires_crisis_resources


@pytest.mark.parametrize("text", EXPLICIT_IDEATION)
def test_explicit_ideation_still_floors_at_t4_and_shows_resources(text):
    """The non-negotiable, unchanged. This is the half that must never regress."""
    verdict = evaluate_conversation([text])
    assert verdict.floor is Tier.T4
    assert verdict.requires_crisis_resources
