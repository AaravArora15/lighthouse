"""The escalation card: what a counsellor reads instead of a transcript.

    python -m lighthouse.model.card              # print a few cards
    python -m lighthouse.model.card --write      # fixtures/escalation_cards.json

Schema locked in `docs/context.md` section 7. This module builds it and nothing else
decides its shape.

## The rule this file exists to enforce

**Every sentence on a card is either a template we wrote or a span the student wrote.**
There is no third category. The LLM's contribution to a card is the summary paragraph and
that is written elsewhere, marked as model prose, and never load-bearing — if the API is
down the card still renders complete, because everything here is deterministic.

That is why the reasons are a *closed* bank rather than generated text. A counsellor
deciding whether to break a child's anonymity should be reading a sentence a human
committed to in advance, not a sentence a model improvised at request time. The cost is
that a case with evidence the bank has no template for gets a thinner card; `MISSES`
counts those so the gap is visible rather than silent.

## Quotes are evidence, so they are verbatim

`citedQuotes` are exact spans from the student's own turns, sliced by offset. They are
never paraphrased, never cleaned up, never truncated mid-word. This is why
`gate/patterns.py:normalize` is length-preserving: an offset computed during gate matching
has to still be correct when it reaches the counsellor's screen, three layers later.

Capped at 3 (`config.MAX_CITED_QUOTES`). A card with eight quotes is a transcript with
extra steps, and the entire point is that a counsellor reads this in fifteen seconds.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Sequence

import numpy as np

from lighthouse import config
from lighthouse.data.synthetic import load, load_turn_probs
from lighthouse.gate.safety import GateHit, SafetyVerdict
from lighthouse.model import markers
from lighthouse.model.features import risk_series
from lighthouse.model.predict import CasePrediction, head
from lighthouse.taxonomy import ESCALATED_TIERS, QUEUED_TIERS, TIERS, Tier

# --------------------------------------------------------------------------------------
# The closed reason bank
# --------------------------------------------------------------------------------------
#
# Keyed by evidence, phrased for a counsellor. Rules for adding one:
#   - Say what the student reported, not what the model computed. "Describes being hit at
#     home" is a reason; "abuse_disclosure fired at weight 1.0" is a log line.
#   - No clinical language. This tool does not diagnose and its copy must not imply it can.
#   - No certainty the evidence does not support. "Describes" and "reports", not "is".

_GATE_REASONS: dict[str, str] = {
    "self_harm_intent": "Describes harming themselves.",
    "suicidal_ideation": "Describes not wanting to be alive.",
    "abuse_disclosure": "Describes being hurt or unsafe at home.",
    "threat_of_violence": "Reports being threatened with violence.",
    "weapon_mention": "Mentions a weapon.",
    "imminent_time_marker": "Refers to something happening imminently.",
}

_TIER_REASONS: dict[Tier, str] = {
    Tier.T0: "No concern identified. Logged only.",
    Tier.T1: "Venting or minor social friction. No counsellor action needed.",
    Tier.T2: "Sustained bullying or exclusion. Routine queue, 48 hours.",
    Tier.T3: "Severe or persistent harassment. Priority queue, 24 hours.",
    Tier.T4: "Immediate risk. Break-glass now; crisis resources were shown to the student.",
}

#: Evidence the bank had no template for. Printed by `--write` so the gap is visible.
MISSES: set[str] = set()


def _gate_reasons(verdict: SafetyVerdict) -> list[str]:
    out: list[str] = []
    for category in verdict.categories:
        template = _GATE_REASONS.get(category.value)
        if template is None:
            MISSES.add(category.value)
            continue
        out.append(template)
    return out


# --------------------------------------------------------------------------------------
# Quote selection
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CitedQuote:
    turnId: str
    text: str
    score: float
    reason: str
    """Why this span is on the card: a gate pattern name, or 'highest-scoring turn'."""


def select_quotes(
    turns: Sequence[str],
    probs: np.ndarray,
    verdict: SafetyVerdict,
    limit: int = config.MAX_CITED_QUOTES,
    *,
    require_evidence: bool = False,
) -> list[CitedQuote]:
    """Up to `limit` verbatim spans, gate hits first, then the highest-risk turns.

    Gate hits outrank classifier scores deliberately. A gate hit can be justified to a
    counsellor in one line ("matched self_harm_intent / first_person_cutting") and a softmax
    cannot. When the two disagree about which turn matters, the explainable one wins.

    Spans shorter than `MIN_QUOTE_CHARS` are widened to the whole turn rather than dropped:
    "i cut myself" is six words of the strongest possible evidence, and showing a counsellor
    a three-word fragment to satisfy a length rule would be worse than showing the sentence.
    """
    quotes: list[CitedQuote] = []
    used_turns: set[int] = set()

    # 1. Gate hits, strongest first, then earliest.
    for hit in sorted(
        verdict.indicators, key=lambda h: (-h.weight, h.turn_index, h.span[0])
    ):
        if len(quotes) >= limit:
            break
        if hit.turn_index in used_turns or hit.turn_index >= len(turns):
            continue
        quotes.append(
            CitedQuote(
                turnId=f"turn-{hit.turn_index}",
                text=_span_or_turn(turns[hit.turn_index], hit),
                score=float(hit.weight),
                reason=hit.describe(),
            )
        )
        used_turns.add(hit.turn_index)

    # 2. Fill remaining slots with the highest-risk turns the gate was silent on. This is
    #    the T2/T3 path: most harassment and identity attack is gate-silent by design, so
    #    without this branch those cards would carry no evidence at all.
    #
    #    Gated on `CONCERN_THRESHOLD`, and that guard is load-bearing rather than tidy.
    #    Without it the fill loop takes the top of `argsort` no matter how low the scores
    #    actually are, and because of the victim-voice gap (context.md section 10) they are
    #    routinely near zero — so a T4 card carrying one devastating gate quote also carried
    #    "i think so. i'm in my room" and "my mum's downstairs" as cited evidence.
    #
    #    Three quotes where two are noise is worse than one quote. It reads as though the
    #    system found three things, and a counsellor who learns the evidence list is padded
    #    stops reading the evidence list. Same argument as dropping orphan modifiers from
    #    the gate's indicators on day 3. Prefer a short card.
    if len(quotes) < limit and len(probs):
        risk = risk_series(np.asarray(probs, dtype=np.float64))
        for index in np.argsort(risk)[::-1]:
            if len(quotes) >= limit:
                break
            index = int(index)
            if index in used_turns or index >= len(turns):
                continue
            if risk[index] < config.CONCERN_THRESHOLD:
                break  # sorted descending, so nothing after this clears the bar either
            if len(turns[index].strip()) < config.MIN_QUOTE_CHARS:
                continue
            quotes.append(
                CitedQuote(
                    turnId=f"turn-{index}",
                    text=turns[index].strip(),
                    score=float(risk[index]),
                    reason="highest-scoring turn",
                )
            )
            used_turns.add(index)

    # 3. Last resort: a queued case must never reach a counsellor with no evidence at all.
    #
    #    Steps 1 and 2 both come up empty on most T2 and T3 conversations, and for a
    #    structural reason rather than a bug. There is no gate category for ordinary
    #    harassment or identity attack, so those tiers are gate-silent *by design* (day 3),
    #    and the victim-voice gap keeps their classifier scores below `CONCERN_THRESHOLD`
    #    (day 4). The first version of this function therefore produced T3 cards with an
    #    empty `citedQuotes`, which is the one outcome worse than a padded card: it asks a
    #    counsellor to action a case while showing them nothing the student said.
    #
    #    So when a case is queued and nothing else qualified, cite the single
    #    highest-scoring turn and **say plainly that it did not clear the bar**. The label
    #    is the honest part — a counsellor reading "no explicit signal" knows to weigh the
    #    quote as context rather than as a finding.
    if require_evidence and not quotes and len(probs) and len(turns):
        risk = risk_series(np.asarray(probs, dtype=np.float64))
        eligible = [
            i
            for i in np.argsort(risk)[::-1]
            if int(i) < len(turns)
            and len(turns[int(i)].strip()) >= config.MIN_QUOTE_CHARS
        ]
        if eligible:
            index = int(eligible[0])
            quotes.append(
                CitedQuote(
                    turnId=f"turn-{index}",
                    text=turns[index].strip(),
                    score=float(risk[index]),
                    reason="no explicit signal; highest-scoring turn",
                )
            )

    return quotes


def _span_or_turn(turn: str, hit: GateHit) -> str:
    """The matched span, widened to the whole turn when the span alone is too short."""
    span = turn[hit.span[0] : hit.span[1]].strip()
    return span if len(span) >= config.MIN_QUOTE_CHARS else turn.strip()


# --------------------------------------------------------------------------------------
# The card
# --------------------------------------------------------------------------------------


@dataclass
class EscalationCard:
    """Field names are camelCase to match `docs/context.md` section 7 and the TS mirror."""

    caseId: str
    handle: str
    tier: str
    confidence: float
    tierFloorReason: str | None
    """Set only when the gate CHANGED the tier. Null when the model already agreed with
    the floor — which is why it must never be used to infer whether a floor exists."""
    gateFloor: str | None
    """The gate's floor for this conversation, independent of whether it moved anything.

    Carried explicitly because day 6 shipped a bug that inferred it from
    `tierFloorReason`: on a T4 case the model already predicted T4, so `apply_verdict`
    had nothing to raise and emitted no reason, and the override endpoint concluded there
    was no floor. A counsellor could then downgrade a self-harm disclosure to T1. The
    floor is a property of the conversation, not of whether it happened to bind."""
    gateIndicators: list[str]
    citedQuotes: list[dict]
    entities: dict[str, list[str]]
    sessionTimeline: list[dict]
    deltaSinceLastSession: str | None
    patternClusterId: str | None
    retentionExpiresAt: str | None

    # Beyond the locked schema, and additive only.
    reasons: list[str] = field(default_factory=list)
    """The closed-bank sentences. What a counsellor actually reads."""
    queueRank: float = 0.0
    escalation: float = 0.0
    modelTier: str = ""
    slaHours: int | None = None
    action: str = ""
    crisisResourcesShown: bool = False
    nStudentTurns: int = 0
    startedAt: str = ""
    """When the conversation began. Drives the queue's age column and the
    time window in cross-conversation clustering."""


def build_card(
    *,
    case_id: str,
    handle: str,
    turns: Sequence[str],
    probs: np.ndarray,
    prediction: CasePrediction,
    started_at: datetime,
) -> EscalationCard:
    """Assemble one card. Deterministic: same inputs, same bytes.

    `started_at` is injected rather than read from the clock so the committed fixture is
    reproducible and a test can assert on retention dates.
    """
    verdict = prediction.verdict
    spec = TIERS[prediction.tier]

    reasons = [_TIER_REASONS[prediction.tier], *_gate_reasons(verdict)]
    reasons.extend(m.capitalize() + "." for m in markers.extract(turns).describe())
    if prediction.floor_reason:
        # The gate's own words, not a paraphrase. If a counsellor asks why the tier moved,
        # they should see the sentence the gate emitted.
        reasons.append(prediction.floor_reason.capitalize() + ".")

    # Escalated cases are exempt from the retention job (`ESCALATED_TIERS`), so their
    # expiry is null rather than a far-future date: "never" and "in 2099" are different
    # promises and only one of them is true.
    retention = (
        None
        if prediction.tier in ESCALATED_TIERS
        else (started_at + timedelta(days=config.RETENTION_DAYS_NON_ESCALATED)).isoformat()
    )

    risk = risk_series(np.asarray(probs, dtype=np.float64)) if len(probs) else []
    timeline = [
        {"turnId": f"turn-{i}", "ordinal": i, "risk": round(float(r), 4)}
        for i, r in enumerate(risk)
    ]

    return EscalationCard(
        caseId=case_id,
        handle=handle,
        tier=prediction.tier.value,
        confidence=round(prediction.confidence, 4),
        tierFloorReason=prediction.floor_reason,
        gateFloor=verdict.floor.value if verdict.floor else None,
        gateIndicators=list(verdict.indicator_names),
        citedQuotes=[
            asdict(q)
            for q in select_quotes(
                turns,
                probs,
                verdict,
                # A queued case must carry evidence. T0/T1 are logged and never
                # actioned, so an empty quote list there is correct, not a gap.
                require_evidence=prediction.tier in QUEUED_TIERS,
            )
        ],
        # Day 7 fills these from LLM entity extraction. Empty, not fabricated.
        entities={"people": [], "places": [], "platforms": []},
        sessionTimeline=timeline,
        deltaSinceLastSession=None,
        patternClusterId=None,
        retentionExpiresAt=retention,
        reasons=reasons,
        queueRank=round(prediction.queue_rank, 4),
        escalation=round(prediction.escalation, 4),
        modelTier=prediction.model_tier.value,
        slaHours=spec.sla_hours,
        action=spec.action,
        crisisResourcesShown=verdict.requires_crisis_resources,
        nStudentTurns=len(turns),
        startedAt=started_at.isoformat(),
    )


OUTPUT = config.FIXTURES_DIR / "escalation_cards.json"

#: Fixed epoch for the committed fixture. A real deployment passes the conversation's own
#: start time; the demo needs bytes that do not change when the file is regenerated.
DEMO_EPOCH = datetime(2026, 8, 9, 9, 0, tzinfo=timezone.utc)


def build_all() -> list[EscalationCard]:
    model = head()
    probs = load_turn_probs()
    cards: list[EscalationCard] = []
    for i, convo in enumerate(load()):
        turn_probs = np.array(probs[convo.id])
        prediction = model.predict_case(turn_probs, convo.student_turns)
        cards.append(
            build_card(
                case_id=convo.id,
                handle=convo.handle,
                turns=convo.student_turns,
                probs=turn_probs,
                prediction=prediction,
                # `days_ago` when the fixture declares one (the day 7 cluster seeds do,
                # so their nine-day window is explicit), otherwise spread evenly over
                # the preceding fortnight to give the queue a realistic age spread.
                started_at=(
                    DEMO_EPOCH - timedelta(days=convo.days_ago)
                    if convo.days_ago is not None
                    else DEMO_EPOCH - timedelta(hours=i * 4)
                ),
            )
        )
    return cards


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write the fixture")
    args = parser.parse_args()

    cards = build_all()
    cards.sort(key=lambda c: -c.queueRank)

    if args.write:
        OUTPUT.write_text(
            json.dumps([asdict(c) for c in cards], indent=2, sort_keys=True) + "\n"
        )
        quoted = sum(len(c.citedQuotes) for c in cards)
        print(f"wrote {OUTPUT.relative_to(config.REPO_ROOT)}")
        print(f"  {len(cards)} cards, {quoted} quotes, "
              f"{sum(len(c.reasons) for c in cards)} reasons")
        print(f"  cards with no quote at all: "
              f"{sum(1 for c in cards if not c.citedQuotes)}")
        print(f"  reason-bank misses: {sorted(MISSES) or 'none'}")
        return

    for card in cards[:6]:
        print(f"\n{'=' * 70}\n{card.caseId}  {card.handle}  "
              f"{card.tier}  conf {card.confidence:.2f}  rank {card.queueRank:.2f}")
        for reason in card.reasons:
            print(f"  - {reason}")
        for quote in card.citedQuotes:
            print(f"  > “{quote['text'][:70]}”  ({quote['reason']})")


if __name__ == "__main__":
    main()
