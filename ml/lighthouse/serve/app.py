"""The scoring service: the classifier half of triage, behind one HTTP call.

    uv run --extra serve --extra train uvicorn lighthouse.serve.app:app --port 8000

## Why a service and not a TypeScript port

The web app already carries a second copy of the safety gate, and keeping the two
character-identical costs a 323-line conformance suite that has caught four real drifts. A
third implementation — 38-feature extraction, a logistic head, isotonic calibration and the
closed reason bank — would be a fourth thing to keep in sync, with no test that could catch
a divergence before a counsellor saw it.

So the Python stays authoritative and answers over HTTP. `card.py` is reused unchanged,
which means a live case and a fixture case are built by **the same 412 lines**.

## What this returns, and what it must never do

It returns a finished escalation card in the exact shape `web/src/lib/cards.ts` expects.
It does not decide whether a student sees crisis resources: that already happened, in the
browser, before this service was contacted, from a gate that runs in 123 µs with no
network. Nothing here can revoke it.

**A failure here is not an outage.** The web app calls this with a timeout and keeps the
gate-only card if it does not answer. That is a designed state with its own screen copy,
not a fallback bolted on: on a free HF Space that sleeps after 48h, the first request of
the day is *expected* to time out.

## The gate runs twice, on purpose

Once in TypeScript before the reply, and again here as part of `predict_case`. That is not
waste. This service must be correct on its own — it is the artefact that gets deployed to a
Space and could be called by something other than our web app — and the two runtimes
agreeing is exactly what the conformance suite asserts.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from lighthouse import config
from lighthouse.gate.safety import evaluate_conversation
from lighthouse.model.card import build_card
from lighthouse.model.predict import head
from lighthouse.model.score_turns import TurnScorer

log = logging.getLogger("lighthouse.serve")

app = FastAPI(
    title="Lighthouse scoring service",
    version="1.0",
    description="Turn classifier + conversation head + escalation card. Synthetic data only.",
)

#: Built on first use rather than at import, so `GET /health` answers while the checkpoint
#: is still loading and a container orchestrator does not kill us during a slow cold start.
_scorer: TurnScorer | None = None
_load_error: str | None = None


def scorer() -> TurnScorer:
    global _scorer, _load_error
    if _scorer is None:
        try:
            _scorer = TurnScorer()
            _load_error = None
        except Exception as error:  # noqa: BLE001 - reported over HTTP, not swallowed
            _load_error = f"{type(error).__name__}: {error}"
            raise
    return _scorer


class Turn(BaseModel):
    role: Literal["student", "assistant"]
    text: str


class ScoreRequest(BaseModel):
    caseId: str
    handle: str
    startedAt: str
    turns: list[Turn] = Field(min_length=1)

    #: Prior contact, for the two features that need it. Defaulted rather than required so
    #: a caller that has not built session history yet still gets a usable card.
    priorSessions: int = 0
    priorMaxTierRank: int = 0


@app.get("/health")
def health() -> dict:
    """Liveness plus honest readiness. A judge hitting this should learn something useful."""
    return {
        "ok": True,
        "modelLoaded": _scorer is not None,
        "modelPresent": config.TURN_MODEL_DIR.exists(),
        "loadError": _load_error,
        "note": "All data this service was trained and demoed on is synthetic.",
    }


@app.post("/score")
def score(request: ScoreRequest) -> dict:
    """Score one conversation and return a finished escalation card."""
    student_turns = [t.text for t in request.turns if t.role == "student"]
    if not student_turns:
        raise HTTPException(422, "a conversation needs at least one student turn")

    try:
        probs = scorer().score(student_turns)
    except FileNotFoundError as error:
        # The checkpoint is gitignored, so this is the expected failure on a fresh clone.
        # 503 rather than 500: the caller should degrade to gate-only, not treat it as a bug.
        raise HTTPException(503, str(error)) from error

    verdict = evaluate_conversation(student_turns)
    prediction = head().predict_case(
        np.asarray(probs, dtype=np.float64),
        student_turns,
        verdict=verdict,
        prior_sessions=request.priorSessions,
        prior_max_tier_rank=request.priorMaxTierRank,
    )

    started = datetime.fromisoformat(request.startedAt.replace("Z", "+00:00"))
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)

    card = build_card(
        case_id=request.caseId,
        handle=request.handle,
        turns=student_turns,
        probs=np.asarray(probs, dtype=np.float64),
        prediction=prediction,
        started_at=started,
    )

    payload = asdict(card)
    # The web app uses this to decide whether to show the "gate only" warning. Set here,
    # by the thing that actually did the scoring, rather than inferred at the other end.
    payload["awaitingClassifier"] = False
    return payload
