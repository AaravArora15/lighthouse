"""Loader and audit report for the hand-authored synthetic conversations.

    python -m lighthouse.data.synthetic          # audit every conversation against the gate

All 80 conversations in ``fixtures/synthetic_conversations.jsonl`` were written by hand.
No API key was available on day 3, and in hindsight that was a better outcome than the
plan: the adversarial cases (``"this coursework is killing me"``, ``"we walked 5 kms"``,
``"i stopped cutting last year"``) are the ones that actually found bugs, and they are
exactly the cases a generator asked for "realistic distressed teenager chat" would not
have produced.

**Every conversation here is fiction.** No student wrote any of it, and none of it is
derived from a real transcript. That statement belongs in the README and on the Devpost
page, per the project non-negotiables.

Each record carries what the gate is *expected* to do with it. That turns "hand-check
every one of them" from a promise into a test: :func:`audit` runs the real gate over all
80 and reports every disagreement, and ``tests/test_synthetic.py`` fails the build on one.
The expectations were written first and reconciled afterwards, so a disagreement means
either the fixture's claim or the gate's behaviour is wrong, and the diff says which.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from functools import lru_cache

from lighthouse import config
from lighthouse.gate.safety import SafetyVerdict, evaluate_conversation
from lighthouse.taxonomy import Tier

FIXTURE = config.FIXTURES_DIR / "synthetic_conversations.jsonl"

STUDENT = "student"


@dataclass(frozen=True)
class SyntheticConversation:
    id: str
    tier: Tier
    handle: str
    scenario: str
    notes: str
    expected_gate: tuple[str, ...]
    expected_floor: Tier | None
    days_ago: float | None
    """Optional age in days, for conversations seeded to exercise time-window
    clustering. `None` means the card builder spaces it evenly with the rest of the
    corpus; the day 7 cluster seeds set it explicitly so the nine-day window is a
    property of the fixture rather than of list order."""
    turns: tuple[tuple[str, str], ...]
    """``(role, text)`` pairs, in order."""

    @property
    def student_turns(self) -> tuple[str, ...]:
        """Only the student speaks to the gate. The assistant's own words must never be
        scored, or the tool would escalate itself for saying the word "crisis"."""
        return tuple(text for role, text in self.turns if role == STUDENT)

    def verdict(self) -> SafetyVerdict:
        return evaluate_conversation(self.student_turns)


@lru_cache(maxsize=1)
def load() -> tuple[SyntheticConversation, ...]:
    if not FIXTURE.exists():
        sys.exit(f"missing {FIXTURE}")

    out: list[SyntheticConversation] = []
    for line_no, line in enumerate(FIXTURE.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.exit(f"{FIXTURE}:{line_no}: {exc}")
        out.append(
            SyntheticConversation(
                id=row["id"],
                tier=Tier(row["tier"]),
                handle=row["handle"],
                scenario=row["scenario"],
                notes=row["notes"],
                expected_gate=tuple(row["expected_gate"]),
                expected_floor=Tier(row["expected_floor"]) if row["expected_floor"] else None,
                days_ago=row.get("days_ago"),
                turns=tuple((t["role"], t["text"]) for t in row["turns"]),
            )
        )
    return tuple(out)


TURN_PROBS = config.FIXTURES_DIR / "synthetic_turn_probs.json"


@lru_cache(maxsize=1)
def load_turn_probs() -> dict[str, list[list[float]]]:
    """Cached per-turn probabilities from ``model.score_turns``.

    Committed alongside the corpus so the conversation head, the ablation and every day 4
    test run with no torch and no checkpoint. Refuses a cache whose label order no longer
    matches the taxonomy: a silently reordered column would corrupt every downstream
    feature while still producing plausible-looking numbers, which is the worst kind of
    bug this project could ship.
    """
    from lighthouse.taxonomy import HARM_ORDER

    if not TURN_PROBS.exists():
        sys.exit(
            f"missing {TURN_PROBS}\nRun: python -m lighthouse.model.score_turns"
        )
    blob = json.loads(TURN_PROBS.read_text())

    expected = [h.value for h in HARM_ORDER]
    if blob.get("label_order") != expected:
        sys.exit(
            f"{TURN_PROBS.name} was built with label order {blob.get('label_order')}, "
            f"taxonomy now says {expected}. Re-run model.score_turns."
        )

    probs = blob["probs"]
    for convo in load():
        rows = probs.get(convo.id)
        if rows is None or len(rows) != len(convo.student_turns):
            sys.exit(
                f"{TURN_PROBS.name} is stale for {convo.id}: has "
                f"{0 if rows is None else len(rows)} rows, corpus has "
                f"{len(convo.student_turns)} student turns. Re-run model.score_turns."
            )
    return probs


@dataclass(frozen=True)
class Disagreement:
    conversation: SyntheticConversation
    field: str
    expected: str
    actual: str

    def __str__(self) -> str:
        return (
            f"{self.conversation.id} [{self.conversation.tier.value}] "
            f"{self.conversation.scenario}\n"
            f"    {self.field}: expected {self.expected}, got {self.actual}"
        )


def audit() -> list[Disagreement]:
    """Run the real gate over every conversation and collect every disagreement."""
    problems: list[Disagreement] = []

    for convo in load():
        verdict = convo.verdict()

        actual_floor = verdict.floor.value if verdict.floor else "none"
        expected_floor = convo.expected_floor.value if convo.expected_floor else "none"
        if actual_floor != expected_floor:
            problems.append(Disagreement(convo, "floor", expected_floor, actual_floor))

        actual_gate = set(verdict.indicator_names)
        expected_gate = set(convo.expected_gate)
        if actual_gate != expected_gate:
            problems.append(
                Disagreement(
                    convo,
                    "categories",
                    str(sorted(expected_gate)),
                    str(sorted(actual_gate)),
                )
            )

        # The floor may never exceed the hand-assigned tier. If it does, the gate is
        # escalating a conversation past what a human reading it thought was warranted,
        # which is the ceiling's whole reason for existing.
        if verdict.floor is not None and verdict.floor.rank > convo.tier.rank:
            problems.append(
                Disagreement(
                    convo, "floor above hand-assigned tier", convo.tier.value, actual_floor
                )
            )

    return problems


def main() -> None:
    conversations = load()
    problems = audit()

    by_tier: dict[str, int] = {}
    floored = crisis = grey_or_high = 0
    for convo in conversations:
        by_tier[convo.tier.value] = by_tier.get(convo.tier.value, 0) + 1
        verdict = convo.verdict()
        floored += verdict.floor is not None
        crisis += verdict.requires_crisis_resources
        grey_or_high += verdict.level.value != "clear"

    turns = sum(len(c.turns) for c in conversations)
    student = sum(len(c.student_turns) for c in conversations)
    print(f"{len(conversations)} conversations, {turns} turns ({student} from students)")
    print("  by tier:", " ".join(f"{t}={n}" for t, n in sorted(by_tier.items())))
    print(f"  gate floors a tier on : {floored}")
    print(f"  crisis resources shown: {crisis}")
    print(f"  grey or high          : {grey_or_high}")

    # The number that matters most in this report. A gate that fires on ordinary school
    # chat gets ignored, and an ignored gate is a broken one.
    benign = [c for c in conversations if c.tier in (Tier.T0, Tier.T1)]
    false_positives = [c for c in benign if c.verdict().floor is not None]
    print(f"\n  T0/T1 conversations   : {len(benign)}")
    print(f"  of those, gate floored: {len(false_positives)}  <- must be 0")
    for convo in false_positives:
        print(f"      {convo.id} {convo.scenario}")

    if problems:
        print(f"\n{len(problems)} DISAGREEMENT(S) between the fixture and the gate:\n")
        for problem in problems:
            print(problem)
        sys.exit(1)

    print("\nall 80 conversations agree with the gate")


if __name__ == "__main__":
    main()
