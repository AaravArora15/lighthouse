"""Contractions and their expansions must floor identically.

## Why this file exists

Two of the first three gate bugs found by running the system were a missing contraction:

* Day 5 — ``"i've been cutting my arms"`` floored T4, ``"i have been cutting my arms"``
  floored nothing. ``have`` was absent from one filler group.
* Day 7 — ``"he says he'll batter me"`` floored nothing while ``'d``, ``would`` and
  ``will`` all worked. ``'ll`` was absent from one alternation.

Both were found by a human writing a sentence the way a student would actually type it,
which is not a repeatable process. **22 of the 66 patterns contain a contraction token**,
so a third of the bank carries this failure mode and only three of them have ever been
probed.

The plan's original remedy was "add expanded-contraction variants to the synthetic
corpus". That was rejected after measuring the surface: five new conversations would
sample perhaps three of the 22 patterns, chosen by whichever sentences happened to occur
to the author — exactly the process that already missed two. This tests all 22 directly.

## What a failure here means

A student who types in full rather than contracted form is not protected. That is the
whole finding, and it is worse than it sounds: expansion is *more* common in distressed,
careful writing than in casual chat, so the gap skews toward the students who are being
most deliberate about what they are disclosing.

## Adding a pattern

If you add a pattern containing an apostrophe form, add its pair here in the same commit.
The parametrised ID is the pattern name, so a failure names the regex directly.
"""

from __future__ import annotations

import pytest

from lighthouse.gate.patterns import PATTERNS
from lighthouse.gate.safety import evaluate_turn

#: ``(pattern name, contracted sentence, expanded sentence)``.
#:
#: One pair for every pattern in the banks that contains an apostrophe form. Both members
#: are written the way a student would actually type them, not as regex-shaped bait — a
#: probe that only exercises the alternation and not the surrounding context proves less
#: than it appears to.
PAIRS: list[tuple[str, str, str]] = [
    # --- self_harm_intent -------------------------------------------------------------
    ("first_person_cutting",
     "i've been cutting my arms",
     "i have been cutting my arms"),
    ("stated_intent_to_self_injure",
     "i'm going to cut myself",
     "i am going to cut myself"),
    ("first_person_self_harm_term",
     "i'm self harming again",
     "i am self harming again"),
    # --- suicidal_ideation ------------------------------------------------------------
    ("going_to_end_it",
     "i'm going to end it all",
     "i am going to end it all"),
    ("first_person_suicidal",
     "i'm suicidal",
     "i am suicidal"),
    ("first_person_suicidal_ve",
     "i've been suicidal for weeks",
     "i have been suicidal for weeks"),
    ("note_for_when_im_gone",
     "i left a letter for when i'm gone",
     "i left a letter for when i am gone"),
    ("has_a_method_in_mind",
     "i've thought about how i'd do it",
     "i have thought about how i would do it"),
    ("knows_how_theyd_do_it",
     "i know how i'd do it",
     "i know how i would do it"),
    ("does_not_want_to_be_here",
     "i don't want to be here",
     "i do not want to be here"),
    ("better_off_without_me",
     "everyone'd be better off without me",
     "everyone would be better off without me"),
    ("no_point_living",
     "what's the point of living",
     "what is the point of living"),
    ("cannot_go_on",
     "i can't go on anymore",
     "i cannot go on anymore"),
    ("tired_of_everything",
     "i'm so tired of everything",
     "im so tired of everything"),
    # --- abuse_disclosure -------------------------------------------------------------
    ("sexual_abuse_disclosure",
     "he touched me in a way i didn't like",
     "he touched me in a way i did not like"),
    ("home_not_safe",
     "i'm not safe at home",
     "im not safe at home"),
    ("home_not_safe_its",
     "it's not safe at home",
     "its not safe at home"),
    ("nobody_at_home_safe",
     "i can't tell anyone at home",
     "i cannot tell anyone at home"),
    # --- threat_of_violence -----------------------------------------------------------
    ("first_person_threat",
     "i'm going to smash him",
     "i am going to smash him"),
    ("will_hurt_you",
     "i'll batter him",
     "ill batter him"),
    ("reported_threat_against_student_ll",
     "kai says he'll batter me",
     "kai says he will batter me"),
    ("reported_threat_against_student_d",
     "kai said he'd batter me",
     "kai said he would batter me"),
    ("youre_dead",
     "he told me you're dead",
     "he told me youre dead"),
    ("group_planning_violence",
     "they're all waiting for me",
     "theyre all waiting for me"),
    ("dead_meat",
     "he said you're gonna get it",
     "he said youre gonna get it"),
]


def _signature(text: str) -> tuple:
    """Floor, score and the set of patterns that fired.

    Compares the whole verdict rather than just the floor, because WEAK patterns score
    without ever flooring — a floor-only check is blind to a third of the bank, which is
    the same shape of blind spot this file exists to close.
    """
    verdict = evaluate_turn(text)
    return (
        verdict.floor.value if verdict.floor else "none",
        round(verdict.score, 4),
        tuple(sorted({h.pattern for h in verdict.indicators})),
    )


@pytest.mark.parametrize(
    "name,contracted,expanded",
    PAIRS,
    ids=[p[0] for p in PAIRS],
)
def test_contraction_and_expansion_floor_identically(
    name: str, contracted: str, expanded: str
) -> None:
    """The same disclosure, typed two ways, must reach the same counsellor."""
    got_contracted = _signature(contracted)
    got_expanded = _signature(expanded)

    assert got_contracted == got_expanded, (
        f"{name}: the same disclosure floors differently depending on typing style.\n"
        f"  {contracted!r} -> {got_contracted}\n"
        f"  {expanded!r} -> {got_expanded}\n"
        "A student who writes in full is not protected. Widen the pattern's alternation "
        "to accept both forms, mirror it in web/src/lib/gate/patterns.ts, and re-run "
        "`python -m lighthouse.gate.export_expectations`."
    )


def test_at_least_one_side_of_each_pair_actually_fires() -> None:
    """Guards the guard.

    A pair where both forms floor ``none`` passes the parity check while proving nothing —
    that is how a probe rots into decoration. Every pair must exercise a live pattern.
    """
    dead = [
        name
        for name, contracted, expanded in PAIRS
        if not _signature(contracted)[2] and not _signature(expanded)[2]
    ]
    assert not dead, (
        f"these pairs floor nothing on either form, so they test nothing: {dead}. "
        "Either the sentence no longer matches the pattern it was written for, or the "
        "pattern was removed."
    )


def test_every_pattern_carrying_a_contraction_has_a_pair() -> None:
    """Coverage, so the next contraction pattern cannot be added without a probe.

    Checked against the live banks rather than a hardcoded list: adding a pattern with an
    apostrophe form and no pair here fails immediately, which is the only way this file
    stays honest as the banks grow.
    """
    tokens = ("'?ll", "'?d", "'?ve", "'?m", "'?re", "'?s", "'?t")
    needs_pair = {
        name
        for bank in PATTERNS.values()
        for entries in bank.values()
        for name, rx in entries
        if any(token in rx for token in tokens)
    }
    # Pair IDs may carry a suffix when one pattern needs several forms probed
    # (`reported_threat_against_student_ll` and `_d` both cover one regex).
    covered = {pid.rsplit("_", 1)[0] for pid, _, _ in PAIRS} | {pid for pid, _, _ in PAIRS}

    missing = {name for name in needs_pair if name not in covered}
    assert not missing, (
        f"patterns contain a contraction but have no parity pair: {sorted(missing)}. "
        "Two of the first three gate bugs were exactly this; add a pair above."
    )
