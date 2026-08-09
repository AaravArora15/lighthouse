"""The synthetic corpus, held to what it claims about itself.

CLAUDE.md's day 3 instruction was "generate ~80 synthetic conversations and hand-check
every one of them". Hand-checking once is a promise that decays the moment a pattern
changes. This file is the hand-check made permanent: every conversation carries the gate
behaviour its author expected, and the build fails when the gate stops agreeing.

Offline, like everything else here. The corpus is committed text and the gate is regex.
"""

from __future__ import annotations

import pytest

from lighthouse.data.synthetic import SyntheticConversation, audit, load
from lighthouse.gate.safety import apply_verdict
from lighthouse.taxonomy import TIER_ORDER, Tier

CONVERSATIONS = load()
IDS = [c.id for c in CONVERSATIONS]


def test_the_corpus_is_the_size_the_plan_asked_for() -> None:
    assert len(CONVERSATIONS) == 85
    assert len({c.id for c in CONVERSATIONS}) == 85
    assert len({c.handle for c in CONVERSATIONS}) == 85, "handles double as demo identities"


def test_every_tier_is_represented_with_real_weight() -> None:
    """A corpus that is 90% T0 proves nothing about escalation, and one that is 90% T4
    proves nothing about precision."""
    counts = {tier: sum(c.tier is tier for c in CONVERSATIONS) for tier in TIER_ORDER}
    assert all(n >= 10 for n in counts.values()), counts
    assert counts[Tier.T4] >= 12, "the tier that must never be missed needs real coverage"


def test_the_gate_agrees_with_every_hand_written_expectation() -> None:
    """The whole point of the file. One assertion, 80 conversations behind it."""
    problems = audit()
    assert not problems, "\n" + "\n".join(str(p) for p in problems)


# --------------------------------------------------------------------------------------
# Precision. The number that decides whether anyone keeps using this.
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("convo", CONVERSATIONS, ids=IDS)
def test_the_gate_never_floors_ordinary_conversation(convo: SyntheticConversation) -> None:
    """No T0 or T1 conversation may pick up a gate floor. Twelve of these are adversarial
    by construction: idiom, negation, academic framing, gaming, food tech, kilometres."""
    if convo.tier not in (Tier.T0, Tier.T1):
        pytest.skip("not a benign conversation")
    verdict = convo.verdict()
    assert verdict.floor is None, (
        f"{convo.id} ({convo.scenario}) floored at {verdict.floor} via "
        f"{[h.describe() for h in verdict.indicators]}"
    )
    assert not verdict.requires_crisis_resources


@pytest.mark.parametrize("convo", CONVERSATIONS, ids=IDS)
def test_no_gate_floor_exceeds_the_hand_assigned_tier(convo: SyntheticConversation) -> None:
    """The gate may under-call a case (the classifier is there to close the gap) but it may
    never escalate past what a human reading the transcript thought was warranted."""
    verdict = convo.verdict()
    if verdict.floor is not None:
        assert verdict.floor.rank <= convo.tier.rank, (
            f"{convo.id} hand-assigned {convo.tier.value}, gate floored {verdict.floor.value}"
        )


# --------------------------------------------------------------------------------------
# Recall. The number that decides whether anyone should.
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "convo", [c for c in CONVERSATIONS if c.tier is Tier.T4], ids=[c.id for c in CONVERSATIONS if c.tier is Tier.T4]
)
def test_every_t4_conversation_reaches_t4_on_the_gate_alone(
    convo: SyntheticConversation,
) -> None:
    """The strongest claim this project makes: if the API is down, the classifier has timed
    out, and the model weights never loaded, every one of these still reaches T4 and still
    puts real crisis numbers in front of the student.

    If this fails, the product's central promise is false, not merely degraded.
    """
    verdict = convo.verdict()
    assert verdict.floor is Tier.T4, (
        f"{convo.id} ({convo.scenario}) only reached "
        f"{verdict.floor.value if verdict.floor else 'no floor'}"
    )
    assert verdict.requires_crisis_resources

    # And a maximally wrong classifier cannot undo it.
    final, reason = apply_verdict(Tier.T0, verdict)
    assert final is Tier.T4
    assert reason


def test_crisis_resources_are_shown_on_exactly_the_t4_conversations() -> None:
    """Not a superset. Showing a crisis line to a student reporting a knife rumour is not
    a harmless over-reaction: it teaches them the tool does not understand what they said."""
    shown = {c.id for c in CONVERSATIONS if c.verdict().requires_crisis_resources}
    expected = {c.id for c in CONVERSATIONS if c.tier is Tier.T4}
    assert shown == expected, f"extra: {shown - expected}, missing: {expected - shown}"


# --------------------------------------------------------------------------------------
# Corpus hygiene.
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("convo", CONVERSATIONS, ids=IDS)
def test_conversations_are_well_formed(convo: SyntheticConversation) -> None:
    assert convo.turns, convo.id
    assert convo.turns[0][0] == "student", "a student always opens; this is an intake tool"
    assert len(convo.student_turns) >= 3, "too short to exercise the conversation head"
    assert convo.notes.strip(), "every conversation must say why it is the tier it is"
    for role, text in convo.turns:
        assert role in {"student", "assistant"}, role
        assert text.strip()


@pytest.mark.parametrize("convo", CONVERSATIONS, ids=IDS)
def test_only_student_turns_are_scored(convo: SyntheticConversation) -> None:
    """The assistant's replies contain the words "crisis", "safe", "suicide" and "knife".
    Scoring them would let the tool escalate a case on the strength of its own output,
    which is the loop this architecture exists to prevent."""
    assistant = [text for role, text in convo.turns if role == "assistant"]
    assert all(text not in convo.student_turns for text in assistant)


def test_assistant_copy_makes_no_clinical_claim() -> None:
    """A non-negotiable: this is a listening and routing tool, not therapy. Copy that
    implies treatment is a product defect, and the demo transcripts are copy."""
    banned = [
        "i can help you get better", "therapy", "diagnos", "treatment plan",
        "i'm a therapist", "as your counsellor", "you have depression",
        "prescri", "you are suffering from",
    ]
    for convo in CONVERSATIONS:
        for role, text in convo.turns:
            if role != "assistant":
                continue
            lowered = text.lower()
            for phrase in banned:
                assert phrase not in lowered, f"{convo.id}: {phrase!r} in {text!r}"


def test_the_corpus_carries_adversarial_negatives() -> None:
    """Twelve benign conversations exist specifically to break the gate. They found three
    real bugs on the day they were written, so if a later edit drops them, say so loudly."""
    hard = [c for c in CONVERSATIONS if "HARD NEGATIVE" in c.scenario]
    assert len(hard) >= 8, "the adversarial negatives are the corpus's most valuable rows"
    assert all(c.tier in (Tier.T0, Tier.T1) for c in hard)
    assert all(c.verdict().floor is None for c in hard)


def test_reading_the_corpus_needs_no_credentials(monkeypatch) -> None:
    for var in ("ANTHROPIC_API_KEY", "HF_TOKEN", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    load.cache_clear()
    assert len(load()) == 85
