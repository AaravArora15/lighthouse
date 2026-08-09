"""Export the Python gate's verdicts so the TypeScript port can be diffed against them.

    python -m lighthouse.gate.export_expectations

Writes ``fixtures/gate_expectations.json``: for all 80 synthetic conversations, the
conversation-level verdict and every per-student-turn verdict, plus a bank of adversarial
one-line probes.

## Why this file exists

The gate now runs in two languages. Python owns the escalation card and every offline
number; TypeScript owns the live-chat path, because a gate that has to make an HTTP call to
a sleeping HF Space cannot honour "crisis resources render unconditionally". Two
implementations of one safety rule is a liability unless something forces them to agree.

This is that something, and it closes the loop in **both** directions:

* ``ml/tests/test_ts_conformance.py`` regenerates this file from the live Python gate and
  fails if the committed copy differs. So a Python pattern edit that is not re-exported
  breaks the Python suite.
* ``web/src/lib/gate/gate.conformance.test.ts`` reads this file, runs the TS gate over the
  same inputs, and diffs every field. So a Python edit that IS re-exported but not mirrored
  in TS breaks the web suite.

Neither test can be satisfied by editing one runtime alone, which is the property we want.

The probes are not decoration. Each one is a bug the gate actually had, or an adversarial
phrasing from the day 3 corpus. A regex that ports "almost right" tends to fail on exactly
these, not on the ordinary conversations.
"""

from __future__ import annotations

import json

from lighthouse import config
from lighthouse.data.synthetic import load
from lighthouse.gate.patterns import pattern_count
from lighthouse.gate.safety import evaluate_conversation, evaluate_turn

OUTPUT = config.FIXTURES_DIR / "gate_expectations.json"

#: Single-turn probes. Every one of these is either a bug the gate had during day 3 or an
#: adversarial phrasing that a naive port gets wrong. Keep the comments: they are why the
#: probe is here, and a future reader deleting a "redundant" probe would lose the reason.
PROBES: tuple[str, ...] = (
    # --- the five day 3 bugs, as regression probes -----------------------------------
    "we walked 5 kms for the charity thing",          # leetspeak vs digits
    "im gonna kill myself",                           # bare \w+ target swallowed "myself"
    "i'm going to end it all tonight",                # same, plus imminence promotion
    "he says he'll make me pay",                      # victim-voice direction
    "i wrote a note for my mum",                      # mandatory qualifier
    "he said he'd stab me after school",              # floor/ceiling contradiction
    # --- the day 5 bug: contraction vs expansion must floor identically ---------------
    "i've been cutting my arms",                      # floored T4 before the fix
    "i have been cutting my arms",                    # floored NOTHING before the fix
    "i had been cutting my arms again",
    "i have stopped cutting my arms",                 # must stay suppressed after the fix
    "i haven't been cutting my arms",                 # must stay suppressed after the fix
    # --- the day 7 bug: every future form of a reported threat must floor ----------
    "kai says he'll batter me",                       # floored NOTHING before the fix
    "kai said he'd batter me",
    "kai says he will batter me",
    "she says she'll kill me",
    "they said they'll beat me",
    # --- suppressor mechanics, containment not co-occurrence -------------------------
    "this coursework is killing me",
    "he told me to kill myself",
    "he told me to kill myself, and honestly i do want to die",
    "i would never kill myself",
    "i'm not going to hurt myself",
    "i stopped cutting last year",
    "it's suicide prevention week at school",
    "we used a butter knife in food tech",
    "i'm gonna smash you at fifa",
    "i still want to die of embarrassment",
    # --- severity grading, the rule that decides break-glass -------------------------
    "i've been cutting my arms",                      # STRONG  -> T4
    "we did a lesson on self harm",                   # suppressed
    "self harm",                                      # MODERATE -> T3, not T4
    "there was a knife",                              # WEAK    -> no floor at all
    "someone brought a knife to school",              # STRONG, one hit not three
    # --- modifiers never floor alone -------------------------------------------------
    "see you tomorrow",
    "after school",
    "i'll see him at lunch",
    # --- leetspeak evasion still caught ----------------------------------------------
    "i w4nt t0 d!e",
    "k1ll my5elf",
    # --- third party, and the empty case ---------------------------------------------
    "my friend said she wants to die and i'm scared",
    "",
    "   ",
)


def build() -> dict:
    conversations = []
    for convo in load():
        turns = convo.student_turns
        conversations.append(
            {
                "id": convo.id,
                "tier": convo.tier.value,
                "n_student_turns": len(turns),
                "conversation": evaluate_conversation(turns).to_dict(),
                "turns": [evaluate_turn(t, i).to_dict() for i, t in enumerate(turns)],
            }
        )

    return {
        "generated_by": "lighthouse.gate.export_expectations",
        "note": (
            "Generated, do not hand-edit. Regenerate with "
            "`python -m lighthouse.gate.export_expectations` after any change under "
            "ml/lighthouse/gate/, and mirror the change in web/src/lib/gate/."
        ),
        "pattern_count": pattern_count(),
        "mirrored_config": {
            "GATE_HIGH_SCORE": config.GATE_HIGH_SCORE,
            "GATE_GREY_SCORE": config.GATE_GREY_SCORE,
            "GATE_SEVERITY_WEIGHTS": config.GATE_SEVERITY_WEIGHTS,
            "GATE_FLOOR_MIN_WEIGHT": config.GATE_FLOOR_MIN_WEIGHT,
            "GATE_CEILING_WITHOUT_T4_EVIDENCE": config.GATE_CEILING_WITHOUT_T4_EVIDENCE,
            "MAX_CITED_QUOTES": config.MAX_CITED_QUOTES,
            "INTAKE_MODEL": config.INTAKE_MODEL,
            "CONCERN_THRESHOLD": config.CONCERN_THRESHOLD,
            "COUNSELLOR_WEEKLY_BUDGET": config.COUNSELLOR_WEEKLY_BUDGET,
            "RETENTION_DAYS_NON_ESCALATED": config.RETENTION_DAYS_NON_ESCALATED,
            "CLASSIFIER_TIMEOUT_SECONDS": config.CLASSIFIER_TIMEOUT_SECONDS,
        },
        "probes": [
            {"text": text, "verdict": evaluate_turn(text).to_dict()} for text in PROBES
        ],
        "conversations": conversations,
    }


def main() -> None:
    payload = build()
    OUTPUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    n_turns = sum(c["n_student_turns"] for c in payload["conversations"])
    print(f"wrote {OUTPUT.relative_to(config.REPO_ROOT)}")
    print(f"  {len(payload['conversations'])} conversations")
    print(f"  {n_turns} per-turn verdicts")
    print(f"  {len(payload['probes'])} probes")
    print(f"  {sum(payload['pattern_count'].values())} patterns")


if __name__ == "__main__":
    main()
