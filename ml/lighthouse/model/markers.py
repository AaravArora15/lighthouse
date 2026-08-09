"""Harm-report markers: the features that survive victim voice.

    from lighthouse.model.markers import extract

## The problem this exists to solve

The turn classifier was trained on Jigsaw comments and Reddit posts. Jigsaw comments *are*
the abuse. This product receives students *describing* abuse, which is a different register
entirely, and the gap is not subtle. Measured on the day 2 checkpoint:

| Same harm, two voices | risk |
|---|---|
| "nobody wants to talk to you, you freak" | **0.964** |
| "nobody in my class has spoken to me in about two weeks" | **0.021** |
| "you're always last picked because you're useless" | **0.939** |
| "every pe lesson they make sure i'm last picked" | **0.019** |

A 45x gap on the same underlying harm. The classifier is not broken; it is answering the
question it was trained on ("is this message toxic?") and we are asking a different one
("is this student being harmed?"). No amount of conversation-level aggregation fixes that,
because there is nothing to aggregate: `1 - P(none)` is 0.02 across the whole transcript.

## What a safeguarding lead actually reads for

Not toxic vocabulary. Four things, none of which require the abuse to be quoted:

* **duration** — "since september", "for two years", "three weeks now"
* **frequency** — "every lesson", "most days", "it keeps happening", "again"
* **avoidance and impact** — has the student changed their life to cope? "I've stopped
  putting my hand up", "I sit in the library every lunch", "I've stopped eating at school".
  This is the strongest of the four in real practice and the one the model half misses
  completely, because avoidance is described in perfectly ordinary language.
* **disclosure barrier** — "I told a teacher and nothing happened", "I haven't told anyone",
  "I lied about the bruises". A student who has already tried and been failed is a
  different case from one making a first report.

Deterministic and lexical, in the same spirit as the safety gate, and for the same reason:
it is explainable to a counsellor, it costs nothing, and it works when everything else is
down. Unlike the gate, this **never floors anything**. It only produces features.

## The honest caveat, which belongs in `docs/results.md`

The synthetic corpus's own T1/T2 boundary is persistence: `syn-014` is a one-off exclusion
and `syn-028` is the fourth time this term. So a persistence feature is partly being
measured against the definition it was built from, and its gain here overstates what it
would do on real intake. It is reported as a separate ablation rung for exactly that
reason. What is *not* circular is the diagnosis above: that measurement came from the
classifier, not the corpus.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

_FLAGS = re.IGNORECASE

# Duration phrases mapped to a rough magnitude in weeks. Precision is not the point; the
# difference between "a week" and "since year 7" is, and that is two orders of magnitude.
_DURATIONS: list[tuple[str, float]] = [
    (r"\b(this|last)\s+week\b", 1),
    (r"\ba\s+week\b", 1),
    (r"\b(a\s+)?(couple|few)\s+of\s+weeks\b", 3),
    (r"\b(two|three|four|five|six|2|3|4|5|6)\s+weeks\b", 3),
    (r"\b(a\s+|last\s+|this\s+)?month\b", 4),
    (r"\bhalf\s+term\b", 6),
    (r"\b(two|three|2|3)\s+months\b", 10),
    (r"\b(all|the\s+whole)\s+(year|term)\b", 30),
    (r"\bthis\s+(year|term)\b", 15),
    (r"\bsince\s+(september|october|november|january|february|easter|christmas|"
     r"half\s+term|the\s+summer|we\s+came\s+back|year\s+\d)\b", 30),
    (r"\b(two|three|four|2|3|4)\s+years\b", 100),
    (r"\bsince\s+year\s+\d\b", 100),
]

_FREQUENCY: list[tuple[str, str]] = [
    ("every_unit", r"\bevery\s+(day|lesson|time|single\s+\w+|week|night|break|lunch)\b"),
    ("most_days", r"\b(most|nearly\s+every)\s+(days|lessons|weeks)\b"),
    ("keeps_doing", r"\b(keep|keeps|kept)\s+\w+ing\b"),
    ("again", r"\b(again|still)\b"),
    ("constant", r"\b(constant|constantly|relentless|non\s?stop|all\s+the\s+time)\b"),
    ("ordinal_recurrence", r"\b(second|third|fourth|fifth|\d+(st|nd|rd|th))\s+time\b"),
    ("countable_volume", r"\b(about\s+|like\s+)?\w+\s+(messages|accounts|times)\s+"
                         r"(a\s+(night|day|week)|now)\b"),
]

# Behaviour change. The student has rearranged their life around the harm.
_AVOIDANCE: list[tuple[str, str]] = [
    ("stopped_doing", r"\bi'?(ve\s+)?(have\s+)?stopped\s+\w+"),
    ("no_longer_goes", r"\bi\s+(don'?t|can'?t|won'?t)\s+(go|use|sit|eat|post|talk)\b"),
    ("hiding_place", r"\b(library|toilets?|sports\s+hall|my\s+room|reception)\s+"
                     r"(every|most|all)\s+(lunch|day|break)\b"),
    ("goes_to_hide", r"\bi\s+(sit|go|hide|stay)\s+in\s+the\s+"
                     r"(library|toilets?|sports\s+hall|changing\s+rooms)\b"),
    ("changed_route", r"\b(changed|avoided|stopped\s+using)\s+(my\s+)?"
                      r"(route|the\s+\w+\s+(staircase|corridor|entrance))\b"),
    ("left_early", r"\bi'?(ve\s+)?(started\s+)?(leaving|left|went)\s+"
                   r"(lessons\s+)?(early|home)\b"),
    ("skips_lessons", r"\bi'?(ve\s+)?(have\s+)?stopped\s+going\s+to\s+(lessons|school)\b"),
    ("withdrew", r"\bi'?(ve\s+)?(have\s+)?stopped\s+(seeing|speaking\s+to)\s+people\b"),
    ("not_eating", r"\bnot\s+eating\s+at\s+school\b"),
]

_DISCLOSURE_BARRIER: list[tuple[str, str]] = [
    ("reported_and_failed", r"\b(reported|told\s+(a\s+)?(teacher|someone|miss|sir))\b"
                            r".{0,60}\b(nothing\s+happened|it\s+got\s+worse|"
                            r"wasn'?t\s+having\s+it|nothing\s+else\s+happened)\b"),
    ("told_nobody", r"\bi\s+(haven'?t|have\s+not|can'?t|cannot)\s+"
                    r"(told|tell)\s+(anyone|anybody|a\s+teacher)\b"),
    ("lied_about_it", r"\bi\s+lied\b"),
    ("sounds_trivial", r"\b(it\s+)?sounds\s+(pathetic|stupid|like\s+nothing|silly)\b"),
    ("sworn_to_secrecy", r"\b(made\s+me\s+promise|if\s+i\s+(told|said)\s+anyone|"
                         r"not\s+to\s+tell\s+anyone)\b"),
    ("stopped_reporting", r"\bi\s+stopped\s+(saying\s+anything|reporting|telling)\b"),
]

# Protected characteristics, detected on the *target* rather than on a slur.
#
# The taxonomy defines T3 as including "targeted discrimination", so this is reading the
# tier definition, not the corpus. It matters because identity attacks are where the
# victim-voice gap bites hardest: the classifier has an `identity_attack` class, but a
# student saying "they keep saying things about where my family are from" scores 0.152 on
# it, and "they've been taking my hijab off in the corridor" scores 0.059. The harm is
# named without a single slur appearing, and the whole class is invisible.
#
# Deliberately excludes accent and clothing, which are the taxonomy's harassment cases and
# not protected characteristics. `syn-031` (mocked for accent) is a T2 and must stay one.
_IDENTITY: list[tuple[str, str]] = [
    ("race_or_ethnicity", r"\b(racist|racial|racism|a\s+slur|slurs|the\s+n\s?word|"
                          r"where\s+(my|our)\s+family\s+(are|is)\s+from|my\s+skin|"
                          r"my\s+(colour|color)|go\s+back\s+to\s+where)\b"),
    ("religion", r"\b(hijab|headscarf|turban|kippah|muslim|islam|islamophob\w+|jewish|"
                 r"antisemit\w+|sikh|hindu|my\s+religion|ramadan|my\s+faith)\b"),
    ("sexuality", r"\b(gay|lesbian|bisexual|queer|homophob\w+|came\s+out|"
                  r"my\s+sexuality|who\s+i\s+fancy)\b"),
    ("gender_identity", r"\b(trans|transgender|transphob\w+|dead\s?nam(e|ed|ing)|"
                        r"my\s+pronouns|misgender\w*)\b"),
    ("disability", r"\b(my\s+(stammer|stutter|hearing\s+aid|wheelchair|dyslexia)|"
                   r"autistic|autism|adhd|disabled|disability|ableis\w+)\b"),
]

_COMPILED_DURATIONS = [(re.compile(rx, _FLAGS), weeks) for rx, weeks in _DURATIONS]
_COMPILED = {
    "frequency": [(n, re.compile(rx, _FLAGS)) for n, rx in _FREQUENCY],
    "avoidance": [(n, re.compile(rx, _FLAGS)) for n, rx in _AVOIDANCE],
    "barrier": [(n, re.compile(rx, _FLAGS)) for n, rx in _DISCLOSURE_BARRIER],
    "identity": [(n, re.compile(rx, _FLAGS)) for n, rx in _IDENTITY],
}

_MAX_WEEKS = 100.0


@dataclass(frozen=True)
class Markers:
    duration_weeks: float
    duration_score: float
    """``duration_weeks`` on a 0-1 log scale, so a week and a year are not 100 apart in a
    linear model that also carries probabilities in [0, 1]."""
    frequency_hits: tuple[str, ...]
    avoidance_hits: tuple[str, ...]
    barrier_hits: tuple[str, ...]
    identity_hits: tuple[str, ...]

    @property
    def values(self) -> dict[str, float]:
        return {
            "duration_score": self.duration_score,
            "frequency_count": float(len(self.frequency_hits)),
            "has_frequency": float(bool(self.frequency_hits)),
            "avoidance_count": float(len(self.avoidance_hits)),
            "has_avoidance": float(bool(self.avoidance_hits)),
            "barrier_count": float(len(self.barrier_hits)),
            "has_identity_target": float(bool(self.identity_hits)),
        }

    def describe(self) -> list[str]:
        """For the escalation card. A counsellor reads these, not the coefficients."""
        out: list[str] = []
        if self.duration_weeks >= 4:
            out.append(f"ongoing for roughly {int(self.duration_weeks)}+ weeks")
        if self.avoidance_hits:
            out.append("student has changed their behaviour to avoid it")
        if len(self.frequency_hits) >= 2:
            out.append("described as recurring")
        if self.identity_hits:
            out.append("targets a protected characteristic: "
                       + ", ".join(h.replace("_", " ") for h in self.identity_hits))
        if self.barrier_hits:
            out.append("barrier to disclosure reported")
        return out


NAMES = [
    "duration_score",
    "frequency_count",
    "has_frequency",
    "avoidance_count",
    "has_avoidance",
    "barrier_count",
    "has_identity_target",
]


def extract(turns: Sequence[str]) -> Markers:
    """Scan a whole transcript. Deliberately conversation-level, not per turn: duration and
    frequency are properties of the account, and a student states them once."""
    text = "\n".join(turns)

    weeks = 0.0
    for rx, magnitude in _COMPILED_DURATIONS:
        if rx.search(text):
            weeks = max(weeks, magnitude)

    def hits(family: str) -> tuple[str, ...]:
        return tuple(name for name, rx in _COMPILED[family] if rx.search(text))

    import math

    return Markers(
        duration_weeks=weeks,
        duration_score=math.log1p(weeks) / math.log1p(_MAX_WEEKS),
        frequency_hits=hits("frequency"),
        avoidance_hits=hits("avoidance"),
        barrier_hits=hits("barrier"),
        identity_hits=hits("identity"),
    )
