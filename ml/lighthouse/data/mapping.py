"""Source datasets and the mapping from their labels onto the Lighthouse taxonomy.

Every label decision made here is a modelling choice that shows up in the results, so
each one carries its reasoning. If you change a mapping, rebuild the splits and say so in
``docs/log.md``.

See ``docs/context.md`` section 10 for licences and why these sources were chosen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from lighthouse.taxonomy import Harm


@dataclass(frozen=True)
class Source:
    key: str
    hf_id: str
    split: str
    text_column: str
    licence: str
    note: str
    to_harm: Callable[[dict], Harm | None]
    """Return the Harm for a row, or None to drop the row."""


# --------------------------------------------------------------------------------------
# Jigsaw toxic comment classification challenge
# --------------------------------------------------------------------------------------
# Multi-label: toxic, severe_toxic, obscene, threat, insult, identity_hate.
# Resolved to a single label by severity priority, because our turn head is single-label.
# Priority order is deliberate: a comment that is both a threat and an insult is a threat,
# and mis-ranking that direction is the expensive mistake.
#
# `obscene` alone is not harassment: profanity directed at nobody is not bullying, and
# treating it as such would flood HARASSMENT with noise and teach the model that swearing
# equals harm. Obscene rows only count when they co-occur with toxic or insult.


def _jigsaw_to_harm(row: dict) -> Harm | None:
    def on(col: str) -> bool:
        return str(row.get(col, "0")).strip() in {"1", "1.0", "True", "true"}

    if on("threat"):
        return Harm.THREAT
    if on("identity_hate"):
        return Harm.IDENTITY_ATTACK
    if on("insult") or on("toxic") or on("severe_toxic"):
        return Harm.HARASSMENT
    if on("obscene"):
        return None  # profanity without a target: ambiguous, drop rather than mislabel
    return Harm.NONE


JIGSAW = Source(
    key="jigsaw",
    hf_id="thesofakillers/jigsaw-toxic-comment-classification-challenge",
    split="train",
    text_column="comment_text",
    licence="CC0 (Wikipedia comments), Jigsaw/Conversation AI",
    note=(
        "159,571 Wikipedia talk-page comments. The only public source in this build that "
        "carries an explicit `threat` label, which is what T3 hangs off."
    ),
    to_harm=_jigsaw_to_harm,
)


# --------------------------------------------------------------------------------------
# Reddit SuicideWatch / depression / teenagers
# --------------------------------------------------------------------------------------
# Three subreddits, which map cleanly onto three of our classes:
#   SuicideWatch -> SELF_HARM   (the T4 signal; nothing else in the corpus provides it)
#   depression   -> DISTRESS    (first-person distress without harm intent)
#   teenagers    -> NONE        (ordinary teen-voice chat: the best in-domain negative
#                                available, and much closer to our users than Wikipedia)
#
# Caveat recorded honestly in the README: a subreddit is a proxy for a label, not a
# clinical annotation. A SuicideWatch post is not verified suicidal ideation, and a
# r/teenagers post is not verified benign.


def _reddit_to_harm(row: dict) -> Harm | None:
    cls = str(row.get("class", "")).strip().lower()
    return {
        "suicidewatch": Harm.SELF_HARM,
        "depression": Harm.DISTRESS,
        "teenagers": Harm.NONE,
    }.get(cls)


REDDIT_SUICIDE = Source(
    key="reddit",
    hf_id="joshyii/suicide_depression_detection",
    split="train",
    text_column="text",
    licence="public Reddit posts, research redistribution",
    note=(
        "348,124 posts across r/SuicideWatch, r/depression, r/teenagers. Supplies "
        "SELF_HARM, DISTRESS and in-domain teen-voice NONE. Deliberately NOT combined "
        "with Ram07/Detection-for-Suicide: both derive from the same SuicideWatch scrape "
        "and mixing them would leak near-duplicates across the train/test boundary."
    ),
    to_harm=_reddit_to_harm,
)


# --------------------------------------------------------------------------------------
# Cyberbullying tweets (the 6-class Kaggle taxonomy)
# --------------------------------------------------------------------------------------
# The four targeted classes are attacks on a protected characteristic, which is exactly
# IDENTITY_ATTACK. `other_cyberbullying` is untargeted bullying, so HARASSMENT.


def _cyberbullying_to_harm(row: dict) -> Harm | None:
    out = str(row.get("output", "")).strip().lower()
    return {
        "not_cyberbullying": Harm.NONE,
        "religion": Harm.IDENTITY_ATTACK,
        "ethnicity": Harm.IDENTITY_ATTACK,
        "gender": Harm.IDENTITY_ATTACK,
        "age": Harm.IDENTITY_ATTACK,
        "other_cyberbullying": Harm.HARASSMENT,
    }.get(out)


CYBERBULLYING = Source(
    key="cyberbullying",
    hf_id="AnikaBasu/CyberbullyingDataset",
    split="train",
    text_column="instruction",  # the tweet itself; 'text' is a constant prompt preamble
    licence="CC0, mirror of Kaggle andrewmvd/cyberbullying-classification",
    note=(
        "2,956 tweets in the 6-class cyberbullying taxonomy. Small, but the only source "
        "with short social-media-length text, which is closer to a chat turn than either "
        "Wikipedia comments or Reddit posts."
    ),
    to_harm=_cyberbullying_to_harm,
)


SOURCES: list[Source] = [JIGSAW, REDDIT_SUICIDE, CYBERBULLYING]


# --------------------------------------------------------------------------------------
# Conversation-level source, used from day 4, not part of the turn-level split
# --------------------------------------------------------------------------------------

ESCONV_HF_ID = "thu-coai/esconv"
ESCONV_LICENCE = "CC-BY-NC-4.0 — non-commercial only, stated in the README"
ESCONV_NOTE = (
    "1,300 annotated multi-turn emotional-support conversations. Used for conversation "
    "structure and as realistic low-tier (T0/T1) negatives on day 4, NOT as turn-level "
    "training labels: 'seeker turn in a support conversation' is too crude a proxy for "
    "a harm label and would poison DISTRESS."
)
