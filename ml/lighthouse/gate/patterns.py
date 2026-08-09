"""Graded regex families for the deterministic safety gate.

The banks live here, separate from the scoring logic in ``safety.py``, because these two
things change for completely different reasons. Patterns change when we learn a new
phrasing; the scoring rules change when the product's risk posture changes. Reviewing a
pattern diff should not mean re-reading the aggregation maths.

Locked design, see ``docs/context.md`` section 6. Six categories, three severities:

* **STRONG** — first-person, unambiguous, and rare enough in ordinary chat that a match is
  worth acting on alone. Floors the tier.
* **MODERATE** — the phrasing is concerning but a benign reading exists. Floors the tier.
* **WEAK** — a topic word with no stance attached. Contributes to the grey score so the
  case is flagged for the conversation head, but **never floors on its own**. This is the
  whole point of grading: `"knife"` in a cooking-class story must not break-glass a child's
  anonymity, but it should not be invisible either.

## Suppressors

Every category carries a list of suppressor patterns. A category hit is dropped when its
span falls inside a suppressor's span. One mechanism covers three distinct failure modes,
which is why suppressors are written to *include* the trigger phrase rather than sit next
to it:

* idiom      — ``"this homework is killing me"`` swallows ``"killing me"``
* negation   — ``"i would never kill myself"`` swallows ``"kill myself"``
* attribution — ``"he told me to kill myself"`` swallows ``"kill myself"``

Attribution is the subtle one and the reason it is not simply deleted: the student is not
disclosing their own intent, so a T4 break-glass (which de-anonymises them) is the wrong
response. But being told to kill yourself is severe harassment, so the same regex appears
again as a STRONG ``threat_of_violence`` pattern. The case lands at a T3 floor: priority
queue, 24h, no de-anonymisation. If the student *also* voices their own ideation elsewhere
in the conversation, that matches separately and floors at T4 as it should.

## What these deliberately do not do

No stemming, no word embeddings, no fuzzy matching. Every fire has to be explainable to a
counsellor in one line ("matched `self_harm_intent / first_person_cutting`"), and a fuzzy
matcher cannot do that. Recall we do not get here is recall the fine-tuned classifier is
supposed to supply. The gate's job is the floor, not the ceiling of detection.
"""

from __future__ import annotations

import re
from enum import Enum

from lighthouse.taxonomy import GateCategory


class Severity(str, Enum):
    """How much a single match is worth. Weights live in ``config``."""

    STRONG = "strong"
    MODERATE = "moderate"
    WEAK = "weak"


SEVERITY_ORDER: list[Severity] = [Severity.WEAK, Severity.MODERATE, Severity.STRONG]


# --------------------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------------------

#: Character-level filter evasion, mapped back to letters. Every entry is a single
#: character replaced by a single character, which keeps ``normalize`` length-preserving.
#: That property is load-bearing: match spans are reported against the ORIGINAL text so
#: escalation cards can quote a student verbatim, and a normaliser that collapsed
#: whitespace or repeated letters would silently shift every offset.
_LEET = str.maketrans({
    "!": "i",
    "1": "i",
    "|": "i",
    "3": "e",
    "4": "a",
    "0": "o",
    "@": "a",
    "$": "s",
    "5": "s",
    "7": "t",
    "*": "",   # not applied — see below
})
# "*" would change length, so it is removed from the table rather than mapped.
del _LEET[ord("*")]


def normalize(text: str) -> str:
    """Lowercase and undo single-character leetspeak. Length-preserving, always.

    Digits are mapped unconditionally, so ``"im 14"`` normalises to ``"im ia"``. That is
    ugly but harmless: nothing in the banks matches bare digit-shaped tokens, and the
    alternative (token-aware mapping) costs the 1:1 offset guarantee that lets us quote
    the student's own words back on the escalation card.
    """
    return text.lower().translate(_LEET)


# --------------------------------------------------------------------------------------
# The banks
# --------------------------------------------------------------------------------------
#
# Each entry is (name, regex). The name is what a counsellor sees; it must read as an
# explanation, not as an internal ID. The regex is never shown to anyone.

Bank = dict[Severity, list[tuple[str, str]]]

_SELF_HARM_INTENT: Bank = {
    Severity.STRONG: [
        (
            # The filler group carries `have`/`had` as well as `been`. Found on day 5 by
            # running the live chat route: "i've been cutting my arms" floored at T4 and
            # "i have been cutting my arms" floored at nothing, purely because the
            # contraction was expanded. The sibling pattern `first_person_self_harm_term`
            # already listed `have\s+been`, so this was an oversight in one pattern rather
            # than a decision. The 80-conversation corpus only ever writes the contracted
            # form, which is exactly why the audit did not catch it.
            "first_person_cutting",
            r"\b(i|i'?ve|ive)\s+(been\s+|have\s+|had\s+|just\s+|already\s+|started\s+)*"
            r"(cut|cuts|cutting|burnt|burned|burning|scratched|scratching)\s+"
            r"(myself|my\s+(arm|arms|wrist|wrists|leg|legs|thigh|thighs|skin))\b",
        ),
        (
            "stated_intent_to_self_injure",
            r"\bi\s+(want|wanna|need|have|am\s+going|'?m\s+going|going)\s+to\s+"
            r"(cut|hurt|harm|burn)\s+myself\b",
        ),
        ("cut_again", r"\bi\s+(cut|hurt)\s+(myself\s+)?again\b"),
        (
            "first_person_self_harm_term",
            r"\bi\s+(have\s+been|'?ve\s+been|am|'?m|was|started|stopped|relapsed)\s+"
            r"\w*\s*self[\s\-]?harm(ing|ed)?\b",
        ),
        ("relapse_with_injury", r"\bi\s+relapsed\b.{0,40}\b(cut|cutting|blade|razor)\b"),
    ],
    Severity.MODERATE: [
        ("self_harm_term", r"\bself[\s\-]?harm(ing|ed|s)?\b"),
        ("hurting_myself", r"\bhurt(ing)?\s+myself\b"),
        ("deserves_pain", r"\bi\s+deserve\s+(the\s+|this\s+)?(pain|to\s+hurt|it)\b"),
        ("own_scars", r"\bmy\s+(cuts|scars|wounds)\b"),
    ],
    Severity.WEAK: [
        ("injury_objects", r"\b(razor|razors|blade|blades)\b"),
        ("hiding_arms", r"\b(long\s+sleeves|cover\s+my\s+arms|hide\s+my\s+arms)\b"),
    ],
}

_SUICIDAL_IDEATION: Bank = {
    Severity.STRONG: [
        (
            # The intensifier slot is not decoration. "i do want to die" and "i just want
            # to die" are both common and both were missed by the first version of this
            # pattern, which required the verb to sit directly after the pronoun.
            "stated_intent_to_die",
            r"\bi\s+(do\s+|really\s+|just\s+|genuinely\s+|honestly\s+|kind\s?of\s+|"
            r"kinda\s+|sometimes\s+|always\s+)*"
            r"(want|wanna|need|have)\s+to\s+"
            r"(die|end\s+it(\s+all)?|end\s+my\s+life|not\s+exist|not\s+be\s+here|"
            r"not\s+wake\s+up|disappear\s+forever)\b",
        ),
        (
            "kill_myself",
            r"\b(kill(ing)?|killed)\s+my\s?self\b",
        ),
        ("unalive_myself", r"\bun\s?alive\s+my\s?self\b"),
        ("euphemism_sewerslide", r"\bsewer\s?slide\b"),
        ("abbreviation_kms", r"\bkms\b"),
        (
            "going_to_end_it",
            r"\b(i'?m|im|i\s+am)\s+(going\s+to|gonna|gna|about\s+to)\s+"
            r"(end\s+it(\s+all)?|end\s+my\s+life|do\s+it\s+tonight)\b",
        ),
        ("take_my_own_life", r"\btake\s+my\s+own\s+life\b"),
        ("wish_i_was_dead", r"\bi\s+wish\s+i\s+(was|were|had\s+never\s+been\s+born)\b"
                            r"(\s+dead|\s+gone)?\b"),
        ("first_person_suicidal", r"\bi\s+(am|'?m|feel|'?ve\s+been|have\s+been)\s+"
                                  r"(really\s+|so\s+|very\s+)?suicidal\b"),
        # Preparation. These are the highest-precision signals in the whole gate: nobody
        # writes them casually, and each one indicates a plan rather than an idea.
        # Tightened after a smoke test floored "i wrote a note for my mum" at T4. A
        # break-glass on that sentence would de-anonymise a child for writing a note.
        # The qualifier is now mandatory: it is what makes the pattern high-precision.
        ("wrote_a_note", r"\b(i\s+)?(wrote|written|writing|finished|left)\s+(a\s+|my\s+)?"
                         r"(suicide|goodbye|good\s?bye|final|last)\s+(note|letter|message)\b"),
        ("note_for_when_im_gone", r"\b(note|letter|message)\s+for\s+(when|after)\s+"
                                  r"i'?m\s+(gone|not\s+here|not\s+around)\b"),
        ("saved_pills", r"\b(saved|saving|collected|collecting|been\s+taking)\s+up?\s*"
                        r"(my\s+)?(pills|tablets|meds|medication)\b"),
        ("giving_things_away", r"\bgiving\s+(away\s+)?(all\s+)?my\s+(stuff|things|"
                               r"clothes|games)\s+away\b"),
        # Method, not just wish. A student who has worked out how is materially further
        # along than one who has not, and none of the patterns above catch it: this
        # phrasing contains no verb of intent and no risk noun at all.
        ("has_a_method_in_mind", r"\bi'?(ve|\s+have)?\s*(thought|think|been\s+thinking)\s+"
                                 r"about\s+how\s+(i'?d|i\s+would|to)\s+do\s+it\b"),
        ("knows_how_theyd_do_it", r"\bi\s+know\s+how\s+(i'?d|i\s+would)\s+do\s+it\b"),
        ("has_a_plan", r"\bi'?(ve|\s+have)\s+(got\s+)?a\s+plan\s+(for|to)\s+"
                       r"(end|kill|when)\b"),
    ],
    Severity.MODERATE: [
        (
            "does_not_want_to_be_here",
            r"\bi\s+(don'?t|do\s+not|dont)\s+want\s+to\s+"
            r"(be\s+here|be\s+alive|live|wake\s+up|exist)\b",
        ),
        (
            "better_off_without_me",
            r"\b(everyone|everybody|they|my\s+(family|mum|mom|dad|parents))\s+"
            r"(would\s+be|'?d\s+be|are|is)\s+better\s+off\s+without\s+me\b",
        ),
        ("no_point_living", r"\bwhat'?s\s+the\s+point\s+(of|in)\s+"
                            r"(living|being\s+here|any\s?of\s?this|anything)\b"),
        ("suicide_term", r"\bsuicid(e|al)\b"),
        ("nobody_would_notice", r"\bno\s?body\s+would\s+(notice|care|miss\s+me)\b"),
        (
            # A student reporting a friend's ideation. Deliberately MODERATE, not STRONG,
            # and deliberately a pattern rather than a suppressor: the first version of
            # this file suppressed it entirely, which made "my friend said she wants to
            # die and i'm scared" score 0.00 and vanish. It is a real signal about a real
            # child. MODERATE floors it at T3 (a counsellor within 24h) instead of T4,
            # because breaking glass on the *reporting* student is the wrong response to
            # a disclosure about somebody else.
            "third_party_disclosure",
            r"\bmy\s+(friend|mate|best\s?friend|sister|brother|cousin|classmate)\s+"
            r"\w{0,10}\s*(said|says|told\s+me|wants|keeps\s+saying|is|has\s+been)\s+"
            r"(that\s+)?(she|he|they)?\s*(wants?\s+to\s+|is\s+going\s+to\s+)?"
            r"(die|kill\s+(her|him|them)\s?self|end\s+it|suicidal|self[\s\-]?harming)\b",
        ),
    ],
    Severity.WEAK: [
        ("cannot_go_on", r"\bi\s+can'?t\s+(do\s+this|go\s+on|keep\s+going)\s+"
                         r"(any\s?more)?\b"),
        ("wants_to_disappear", r"\bi\s+(just\s+)?want\s+to\s+disappear\b"),
        ("tired_of_everything", r"\b(i'?m|im)\s+(so\s+)?tired\s+of\s+"
                                r"(everything|all\s+of\s+this|being\s+here)\b"),
    ],
}

_ABUSE_DISCLOSURE: Bank = {
    Severity.STRONG: [
        (
            "caregiver_violence",
            r"\b(my\s+)?(dad|father|mum|mom|mother|step\s?dad|step\s?father|step\s?mum|"
            r"step\s?mom|uncle|aunt|older\s+brother|brother|cousin|coach|carer|"
            r"foster\s+(dad|mum|mom|parent))\s+"
            r"(hits|hit|beats|beat|punched|punches|kicked|kicks|strangled|"
            r"burnt|burned|hurts|hurt)\s+me\b",
        ),
        (
            "sexual_abuse_disclosure",
            r"\b(touch(ed|es|ing)?)\s+me\s+"
            r"(inappropriately|where\s+he\s+shouldn'?t|down\s+there|when\s+i\s+was\s+"
            r"asleep|in\s+a\s+way\s+i\s+didn'?t\s+like)\b",
        ),
        ("made_me_do_things", r"\bmade\s+me\s+(touch|do)\s+(him|her|things|stuff)\b"),
        ("beaten_at_home", r"\bi\s+(get|got|keep\s+getting)\s+"
                           r"(hit|beaten|beat\s+up|slapped|punched)\s+at\s+home\b"),
        ("home_not_safe", r"\b(it'?s|i'?m|im)\s+not\s+safe\s+(at\s+home|there|"
                          r"in\s+my\s+(house|home))\b"),
    ],
    Severity.MODERATE: [
        # MODERATE, not STRONG. A classic abuse red flag, but "scared to go home" also
        # covers a failed test and a lost phone. T3 puts a counsellor on it inside 24h,
        # which is the proportionate response to a phrase with a live benign reading.
        ("afraid_to_go_home", r"\b(scared|afraid|terrified|dreading)\s+"
                              r"(to\s+go|of\s+going|going)\s+home\b"),
        ("scared_of_caregiver", r"\b(scared|afraid|terrified)\s+of\s+(my\s+)?"
                                r"(dad|father|mum|mom|mother|step\s?dad|step\s?mum|"
                                r"step\s?mom|uncle|carer)\b"),
        ("bruises_from_home", r"\bbruis(e|es|ed|ing)\b.{0,50}\b(home|dad|mum|mom|him|her)\b"),
        ("nobody_at_home_safe", r"\bi\s+(can'?t|cannot)\s+(tell|talk\s+to)\s+"
                                r"(anyone\s+)?at\s+home\b"),
    ],
    Severity.WEAK: [
        ("home_is_bad", r"\bthings\s+(are|get)\s+(bad|worse)\s+at\s+home\b"),
        ("hiding_at_home", r"\b(hide|hiding|lock(ed)?\s+myself)\s+in\s+my\s+room\b"),
    ],
}

_THREAT_OF_VIOLENCE: Bank = {
    Severity.STRONG: [
        (
            # The target list is closed on purpose. An earlier version ended with a bare
            # `\w+`, which made "i'm going to end it all tonight" and "im gonna kill
            # myself" both register as threats against another person: the catch-all
            # swallowed "it" and "myself". A missed threat against a named individual is
            # the price, and the classifier is the half of the system that covers names.
            "first_person_threat",
            r"\b(i'?m|im|i\s+am)\s+(going\s+to|gonna|gna)\s+"
            r"(kill|batter|stab|shoot|jump|smash|end)\s+"
            r"(you|him|her|them|us|that\s+\w+)\b",
        ),
        (
            "will_hurt_you",
            r"\bi'?ll\s+(kill|batter|stab|shoot|jump|smash|hurt|beat)\s+"
            r"(you|him|her|them)\b",
        ),
        (
            "reported_threat_against_student",
            r"\b(he|she|they|\w+)\s+(said|says|told\s+me)\s+"
            # `'?ll` sits beside `'?d` because every other future form already worked
            # ('d, would, will, was going to) and only the `'ll` contraction did not —
            # so "he said he'd batter me" floored at T3 and "he says he'll batter me"
            # floored at nothing. Found on day 7 by writing a seeded conversation in the
            # phrasing a student would actually use. Same shape as the day 5 contraction
            # gap in `first_person_cutting`: one form covered, its sibling missed.
            r"(that\s+)?(he|she|they)?\s*('?d|'?ll|\s+would|\s+was\s+going\s+to|"
            r"\s+is\s+going\s+to|\s+will)\s+"
            r"(kill|batter|stab|shoot|jump|hurt|beat)\s+me\b",
        ),
        (
            "threatened_to",
            r"\bthreaten(ed|ing)?\s+to\s+(kill|batter|stab|shoot|hurt|beat|jump)\b",
        ),
        # Told to kill yourself. Severe harassment, and the reason the matching
        # attribution regex also suppresses the suicidal_ideation banks: this is not the
        # student's own intent, so it must not trigger a T4 break-glass on its own.
        (
            "told_target_to_kill_themselves",
            r"\b(told|telling|tells|said|saying|says|keep\s+telling)\s+"
            r"(me|him|her|them)\s+(that\s+)?(i|he|she|they)?\s*(should\s+)?(to\s+)?"
            r"(go\s+)?(kill\s+(my|your|him|her|them)\s?self|kys|just\s+die|"
            r"un\s?alive\s+(my|your)\s?self)\b",
        ),
        ("kys_abbreviation", r"\bkys\b"),
        ("wait_until_i_see_you", r"\bwait\s+(til|till|until)\s+i\s+"
                                 r"(see|catch|find|get)\s+(you|him|her|them)\b"),
        ("youre_dead", r"\byou'?re\s+dead\b"),
    ],
    Severity.MODERATE: [
        # "me" is in every target list here, and it is not an afterthought. These patterns
        # were first written from the perpetrator's point of view ("make you pay"), which
        # misses the direction this product actually receives: a victim reporting what was
        # said to them ("he says he'll make me pay"). Two synthetic conversations scored
        # zero because of it.
        ("beat_you_up", r"\b(beat|batter|jump|do)\s+(you|him|her|them|me)\s+up\b"),
        ("coming_for_you", r"\b(coming|going)\s+(to\s+)?(get|find)\s+(you|him|her|them|me)\b"),
        ("make_you_pay", r"\bmake\s+(you|him|her|them|me)\s+(pay|regret\s+it|sorry)\b"),
        ("group_planning_violence", r"\bthey'?re\s+(all\s+)?(waiting|planning)\s+"
                                    r"(for\s+me|to\s+get\s+me)\b"),
    ],
    Severity.WEAK: [
        ("fight_talk", r"\b(fight|scrap)\s+(you|him|her|them)\b"),
        ("dead_meat", r"\b(you|he|she|they)'?re\s+(gonna\s+)?get\s+it\b"),
    ],
}

_WEAPON_MENTION: Bank = {
    Severity.STRONG: [
        (
            "weapon_being_carried",
            r"\b(bring|brings|bringing|brought|carry|carrying|carried|got|has|have|had|"
            r"pulled|showed|waving)\s+(a\s+|the\s+|his\s+|her\s+|their\s+)?"
            r"(knife|knives|blade|machete|gun|pistol|firearm|shank|hammer|bat)\b",
        ),
        (
            "weapon_at_school",
            r"\b(knife|knives|blade|machete|gun|pistol|firearm|shank)\b"
            r".{0,30}\b(school|class|lesson|playground|gates|bus)\b",
        ),
    ],
    Severity.MODERATE: [
        (
            "weapon_attributed_to_person",
            r"\b(he|she|they|his|her|their|someone)\s+\w{0,12}\s*"
            r"(knife|knives|blade|machete|gun|pistol|shank)\b",
        ),
    ],
    Severity.WEAK: [
        ("bare_weapon_noun", r"\b(knife|knives|blade|machete|gun|pistol|firearm|"
                             r"shank|weapon|weapons)\b"),
    ],
}

# Never floors on its own; see ``taxonomy.gate_floor``. Single severity by design, because
# "tonight" is not more imminent than "after school" in any way we can measure.
_IMMINENT_TIME_MARKER: Bank = {
    Severity.MODERATE: [
        (
            "imminent_window",
            r"\b(tonight|to\s?night|today|tomorrow|this\s+(afternoon|evening|morning|"
            r"break|lunch|weekend)|after\s+school|before\s+school|at\s+lunch|"
            r"next\s+(period|lesson)|in\s+an?\s+(hour|minute|bit)|right\s+now|"
            r"on\s+my\s+way\s+home|when\s+i\s+get\s+home|any\s+minute)\b",
        ),
    ],
}

PATTERNS: dict[GateCategory, Bank] = {
    GateCategory.SELF_HARM_INTENT: _SELF_HARM_INTENT,
    GateCategory.SUICIDAL_IDEATION: _SUICIDAL_IDEATION,
    GateCategory.ABUSE_DISCLOSURE: _ABUSE_DISCLOSURE,
    GateCategory.THREAT_OF_VIOLENCE: _THREAT_OF_VIOLENCE,
    GateCategory.WEAPON_MENTION: _WEAPON_MENTION,
    GateCategory.IMMINENT_TIME_MARKER: _IMMINENT_TIME_MARKER,
}


# --------------------------------------------------------------------------------------
# Suppressors
# --------------------------------------------------------------------------------------
#
# A hit is dropped when its span sits inside a suppressor's span, so every suppressor must
# span the trigger phrase it is cancelling. Test the containment, not just the match.

_SELF_HARM_SUPPRESSORS: list[tuple[str, str]] = [
    (
        # \s* not \s+ after the pronoun: the contraction in "i'm not going to" leaves no
        # space between "i" and "'m", and requiring one made this suppressor silently dead
        # for the single most common way a student reassures you.
        "negated_self_harm",
        r"\bi\s*(would\s+never|will\s+never|'?m\s+not\s+going\s+to|"
        r"am\s+not\s+going\s+to|don'?t\s+want\s+to|never)\s+"
        r"(cut|hurt|harm|burn)\s+myself\b",
    ),
    (
        "recovery_framing",
        r"\bi\s+(stopped|quit|haven'?t|have\s+not|used\s+to)\s+"
        r"\w{0,12}\s*(cut|cutting|self[\s\-]?harm(ing|ed)?|hurt\s+myself)\b",
    ),
    (
        "topic_not_disclosure",
        r"\b(book|novel|film|movie|show|song|documentary|essay|assignment|project|"
        r"article|poem|presentation|lesson|talk|website|charity)\s+"
        r"(about|on|for)\s+\w{0,12}\s*self[\s\-]?harm(ing)?\b",
    ),
    (
        "support_service_name",
        r"\bself[\s\-]?harm\s+"
        r"(prevention|awareness|support|helpline|hotline|charity|week|campaign|service)\b",
    ),
]

_SUICIDE_SUPPRESSORS: list[tuple[str, str]] = [
    (
        "negated_ideation",
        r"\bi\s*(would\s+never|will\s+never|'?m\s+not\s+going\s+to|"
        r"am\s+not\s+going\s+to|never\s+said\s+i'?d|don'?t\s+want\s+to)\s+"
        r"(kill\s+my\s?self|die|end\s+it(\s+all)?|end\s+my\s+life|"
        r"un\s?alive\s+my\s?self)\b",
    ),
    (
        "reassurance",
        r"\b(i'?m|im)\s+not\s+(suicidal|going\s+to\s+do\s+anything|"
        r"going\s+to\s+hurt\s+my\s?self)\b",
    ),
    (
        # The student is reporting harassment, not disclosing intent. The same regex is a
        # STRONG threat_of_violence pattern, so the case still floors at T3.
        "told_by_someone_else",
        r"\b(told|telling|tells|said|saying|says|keep\s+telling)\s+"
        r"(me|him|her|them)\s+(that\s+)?(i|he|she|they)?\s*(should\s+)?(to\s+)?"
        r"(go\s+)?(kill\s+(my|your|him|her|them)\s?self|kys|just\s+die|"
        r"un\s?alive\s+(my|your)\s?self)\b",
    ),
    (
        "topic_not_disclosure",
        r"\b(book|novel|film|movie|show|song|lyrics|documentary|essay|assignment|"
        r"project|article|poem|presentation|lesson|talk|website|charity|news)\s+"
        r"(about|on|for)\s+\w{0,12}\s*(suicide|suicidal|killing\s+(your|him|her)\s?self)\b",
    ),
    (
        "support_service_name",
        r"\bsuicid(e|al)\s+"
        r"(prevention|awareness|support|helpline|hotline|charity|week|campaign|"
        r"service|rates?|statistics)\b",
    ),
    (
        "hyperbole_killing_me",
        r"\b(homework|revision|exam|exams|essay|coursework|training|practice|this|that|"
        r"my\s+\w+|the\s+\w+|it)\s+(is|are|'?s|'?re|was|were)\s+"
        r"(literally\s+|actually\s+|so\s+)?killing\s+me\b",
    ),
    ("kill_for", r"\b(could|would)\s+kill\s+for\s+(a|an|some)\b"),
    ("distance_kms", r"\b\d+\s?kms?\b"),
    (
        # Must span back to the pronoun, because that is where the ideation match starts.
        "die_of_embarrassment",
        r"\bi\s+(just\s+|literally\s+|actually\s+|still\s+)*(want|wanna)\s+to\s+die\s+"
        r"(of|from)\s+(embarrassment|shame|cringe|laughing|laughter|boredom)\b",
    ),
    ("dying_idiom", r"\b(dying|dead)\s+(of|from)\s+(laughter|boredom|embarrassment)\b"),
]

_ABUSE_SUPPRESSORS: list[tuple[str, str]] = [
    (
        "fictional_or_historical",
        r"\b(in\s+the\s+(book|film|movie|show|story)|the\s+character|we\s+read\s+about)\b"
        r".{0,60}\b(hit|beat|hurt)\s+me\b",
    ),
    (
        "play_fighting",
        r"\b(play|playing|joking|messing|pretend)\s+\w{0,10}\s*"
        r"(hit|hits|fight|fighting)\s+me\b",
    ),
]

_THREAT_SUPPRESSORS: list[tuple[str, str]] = [
    (
        "gaming_context",
        r"\b(in\s+(the\s+)?game|on\s+(fortnite|minecraft|roblox|cod|fifa)|"
        r"my\s+(character|team)|respawn|final\s+boss|the\s+boss)\b"
        r".{0,40}\b(kill|shoot|stab|batter)\s+(you|him|her|them)\b",
    ),
    (
        # Must span the pronoun too, or containment fails: the threat pattern's match
        # starts at "i'm", so a suppressor starting at "gonna" sits inside it rather than
        # around it and cancels nothing.
        "sports_or_game_idiom",
        r"\b(i'?m\s+|im\s+|i\s+am\s+|we'?re\s+|we\s+are\s+)?"
        r"(gonna|going\s+to|gna)\s+(smash|batter|destroy|beat|thrash|end)\s+"
        r"(you|him|her|them)\s+(at|in|on)\s+\w+\b",
    ),
]

_WEAPON_SUPPRESSORS: list[tuple[str, str]] = [
    (
        "kitchen_or_craft_context",
        r"\b(kitchen|butter|bread|cooking|food\s?tech|craft|carving|penknife|"
        r"scout|camping|dinner)\s+\w{0,8}\s*(knife|knives|blade)\b",
    ),
    (
        "gaming_context",
        r"\b(in\s+(the\s+)?game|fortnite|minecraft|roblox|cod|warzone|nerf|water)\s+"
        r"\w{0,10}\s*(gun|knife|blade)\b",
    ),
    ("figurative_gun", r"\b(jumped\s+the\s+gun|gun\s+it|glue\s+gun|nerf\s+gun)\b"),
]

SUPPRESSORS: dict[GateCategory, list[tuple[str, str]]] = {
    GateCategory.SELF_HARM_INTENT: _SELF_HARM_SUPPRESSORS,
    GateCategory.SUICIDAL_IDEATION: _SUICIDE_SUPPRESSORS,
    GateCategory.ABUSE_DISCLOSURE: _ABUSE_SUPPRESSORS,
    GateCategory.THREAT_OF_VIOLENCE: _THREAT_SUPPRESSORS,
    GateCategory.WEAPON_MENTION: _WEAPON_SUPPRESSORS,
    GateCategory.IMMINENT_TIME_MARKER: [],
}


# --------------------------------------------------------------------------------------
# Compilation
# --------------------------------------------------------------------------------------
#
# Compiled once at import. The gate sits in front of every student turn in a live chat, so
# recompiling per call would put regex compilation on the latency path for no reason.

_FLAGS = re.IGNORECASE | re.DOTALL

COMPILED_PATTERNS: dict[GateCategory, dict[Severity, list[tuple[str, re.Pattern[str]]]]] = {
    category: {
        severity: [(name, re.compile(rx, _FLAGS)) for name, rx in entries]
        for severity, entries in bank.items()
    }
    for category, bank in PATTERNS.items()
}

COMPILED_SUPPRESSORS: dict[GateCategory, list[tuple[str, re.Pattern[str]]]] = {
    category: [(name, re.compile(rx, _FLAGS)) for name, rx in entries]
    for category, entries in SUPPRESSORS.items()
}


def pattern_count() -> dict[str, int]:
    """Bank sizes, for the log entry and for `docs/results.md`."""
    return {
        category.value: sum(len(v) for v in bank.values())
        for category, bank in PATTERNS.items()
    }
