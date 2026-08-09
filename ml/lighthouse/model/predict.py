"""The inference entry point. Conversation in, calibrated tier out.

    python -m lighthouse.model.predict --fit     # fit on all 80 rows, write the artefact
    python -m lighthouse.model.predict           # show predictions for the corpus

## Why this file exists at all

`conversation_head.py` answers "how good is this model", and it answers it honestly:
everything there is cross-validated, and `main()` fits the full model exactly once, prints
the coefficient table, and throws it away. That is correct for a report and useless for a
product. Nothing persisted a fitted estimator, nothing persisted the isotonic calibrator,
and there was no `predict(conversation) -> Tier` anywhere in the repo — so days 6 and 7,
which both assume an escalation card exists, had nothing to build on.

This is the missing half: fit once on everything, write the parameters down, and expose a
function that turns one conversation into one tier.

## Weights as JSON, not as a pickle

The artefact is `data/artifacts/conversation_head.params.json`: scaler mean and scale,
logistic coefficients and intercepts, and the isotonic calibrator's knots. Three reasons,
in order of how much they matter:

1. **A pickle is executable.** Loading one runs arbitrary code from the file. This model
   decides whether a child's case reaches a counsellor; the artefact that encodes it
   should be inspectable text, not a payload.
2. **It survives version drift.** A joblib pickle is bound to the scikit-learn version
   that wrote it, and day 9 deploys to a Space we have not built yet.
3. **It is portable.** Standardise, dot product, softmax, interpolate — a linear model is
   arithmetic. If the day 9 Space is more trouble than it is worth, the same numbers run
   in TypeScript with no Python at all. That option stays open because of this format.

## What this deliberately does NOT do

It does not apply the gate. `predict_tier` returns what the *model* thinks, and the caller
passes it through `gate.safety.apply_verdict` to get what the *product* says. Keeping the
floor out of this file is what keeps "no model output may lower a gate floor" enforceable
in one place. `predict_case` below is the composed version, and it is the one callers want.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Sequence

import numpy as np
from sklearn.isotonic import IsotonicRegression

from lighthouse import config
from lighthouse.data.synthetic import load, load_turn_probs
from lighthouse.gate.safety import SafetyVerdict, apply_verdict, evaluate_conversation
from lighthouse.model.conversation_head import ESCALATED, _model, _ranker, build_rows
from lighthouse.model.features import ABLATIONS, featurise, names_for
from lighthouse.taxonomy import TIER_ORDER, Tier

PARAMS_PATH = config.ARTIFACTS_DIR / "conversation_head.params.json"

#: The feature set the shipped model uses. `full` rather than `+report` even though
#: `history` contributes exactly zero on this corpus (day 4), because day 6 seeds returning
#: students and the column has to already be there when it stops being inert.
SHIPPED_GROUPS = ABLATIONS["full"]


# --------------------------------------------------------------------------------------
# Fitting
# --------------------------------------------------------------------------------------


def _dump_pipeline(pipeline) -> dict:
    """Pull a `StandardScaler -> LogisticRegression` pipeline apart into plain numbers."""
    scaler, clf = pipeline[0], pipeline[-1]
    return {
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "coef": clf.coef_.tolist(),
        "intercept": clf.intercept_.tolist(),
        "classes": [int(c) for c in clf.classes_],
    }


def fit_and_save() -> dict:
    """Fit the tier head, the escalation ranker, and the calibrator on **all** 80 rows.

    Fitting on everything is correct here and would be wrong in `conversation_head.py`.
    That file measures generalisation, so it never lets a model see the row it is scored
    on. This file ships a model, and a model shipped to a school should have been trained
    on every example we have. The honest performance numbers stay where they were measured:
    cross-validated, in `docs/results.md`. Do not quote a number produced by this file.
    """
    rows = build_rows()
    X = np.vstack([r.features.vector(SHIPPED_GROUPS) for r in rows])
    y = np.array([r.tier.rank for r in rows])
    needs_counsellor = np.isin(y, [t.rank for t in ESCALATED]).astype(int)

    head = _model()
    head.fit(X, y)

    ranker = _ranker()
    ranker.fit(X, needs_counsellor)

    # The calibrator is fitted on out-of-fold ranker scores, never on the in-sample ones.
    # In-sample scores from a model that has seen every row are near-separable, and an
    # isotonic fitted on those collapses to a step function that reports 0.02 or 0.98 and
    # nothing in between — perfectly confident and completely uninformative.
    from lighthouse.model.conversation_head import _inner_escalation

    inner_raw, inner_true = _inner_escalation(X, needs_counsellor)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    iso.fit(inner_raw, inner_true)

    params = {
        "note": (
            "Generated by `python -m lighthouse.model.predict --fit`. Fitted on all 80 "
            "synthetic conversations. These weights are for INFERENCE ONLY — every "
            "performance number in docs/results.md is cross-validated and comes from "
            "conversation_head.py, not from a model fitted on its own test set."
        ),
        "seed": config.SEED,
        "n_train": len(rows),
        "feature_groups": list(SHIPPED_GROUPS),
        "feature_names": names_for(SHIPPED_GROUPS),
        "tier_order": [t.value for t in TIER_ORDER],
        "head": _dump_pipeline(head),
        "ranker": _dump_pipeline(ranker),
        "isotonic": {
            "x": iso.X_thresholds_.tolist(),
            "y": iso.y_thresholds_.tolist(),
        },
    }

    config.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    PARAMS_PATH.write_text(json.dumps(params, indent=2) + "\n")
    return params


# --------------------------------------------------------------------------------------
# Loading and predicting
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TierPrediction:
    """What the model alone says. Not what the product says — see `predict_case`."""

    tier: Tier
    confidence: float
    """P(tier), from the five-class head."""
    escalation: float
    """Calibrated P(needs a counsellor). This is what the queue is ranked by."""
    proba: dict[str, float]


@dataclass(frozen=True)
class CasePrediction:
    """What the product says: the model, constrained by the gate."""

    tier: Tier
    """Post-gate. This is the tier on the escalation card."""
    model_tier: Tier
    """Pre-gate, kept so a card can show that the gate moved it."""
    confidence: float
    escalation: float
    proba: dict[str, float]
    verdict: SafetyVerdict
    floor_reason: str | None
    """Non-null when the gate raised or capped the tier. Rendered verbatim on the card."""

    @property
    def queue_rank(self) -> float:
        """Sort key for the counsellor queue: `floor_rank + escalation`.

        Day 4 established this is the product's ranking, not the model's, and that ranking
        by the model score alone understated recall@20 by 0.15. The floor is the primary
        sort and the model is the tie-break, which is exactly the documented precedence.
        """
        floor_rank = self.verdict.floor.rank if self.verdict.floor else 0
        return float(floor_rank) + float(np.clip(self.escalation, 0.0, 1.0))


class ConversationHead:
    """A fitted head loaded from JSON. Construct via `ConversationHead.load()`."""

    def __init__(self, params: dict) -> None:
        self.params = params
        self.feature_groups = tuple(params["feature_groups"])
        self.feature_names = list(params["feature_names"])
        self._head = params["head"]
        self._ranker = params["ranker"]
        self._iso_x = np.array(params["isotonic"]["x"], dtype=np.float64)
        self._iso_y = np.array(params["isotonic"]["y"], dtype=np.float64)

    @classmethod
    def load(cls, path=PARAMS_PATH) -> "ConversationHead":
        if not path.exists():
            raise FileNotFoundError(
                f"{path} is missing. Run: python -m lighthouse.model.predict --fit"
            )
        return cls(json.loads(path.read_text()))

    @staticmethod
    def _decision(block: dict, x: np.ndarray) -> np.ndarray:
        z = (x - np.array(block["scaler_mean"])) / np.array(block["scaler_scale"])
        return np.array(block["coef"]) @ z + np.array(block["intercept"])

    def _softmax(self, block: dict, x: np.ndarray) -> dict[int, float]:
        scores = self._decision(block, x)
        # Binary logistic regression stores one row of coefficients, not two.
        if scores.shape[0] == 1:
            p1 = 1.0 / (1.0 + np.exp(-scores[0]))
            probs = np.array([1.0 - p1, p1])
        else:
            shifted = scores - scores.max()
            exp = np.exp(shifted)
            probs = exp / exp.sum()
        return {int(c): float(p) for c, p in zip(block["classes"], probs)}

    def predict_tier(self, features) -> TierPrediction:
        """Model only. The gate has not been applied."""
        x = features.vector(self.feature_groups)

        by_rank = self._softmax(self._head, x)
        proba = {t.value: by_rank.get(t.rank, 0.0) for t in TIER_ORDER}
        best_rank = max(by_rank, key=lambda r: by_rank[r])

        raw = self._softmax(self._ranker, x).get(1, 0.0)
        # Piecewise-linear interpolation over the isotonic knots, clipped at the ends —
        # the same thing sklearn's `predict` does, without the sklearn dependency.
        escalation = float(np.interp(raw, self._iso_x, self._iso_y))

        return TierPrediction(
            tier=TIER_ORDER[best_rank],
            confidence=by_rank[best_rank],
            escalation=escalation,
            proba=proba,
        )

    def predict_case(
        self,
        probs: np.ndarray,
        turns: Sequence[str],
        *,
        verdict: SafetyVerdict | None = None,
        prior_sessions: int = 0,
        prior_max_tier_rank: int = 0,
    ) -> CasePrediction:
        """The whole pipeline: features -> head -> gate. What a caller actually wants.

        `t4_override` is passed when the head is confidently predicting T4 itself, so a
        self-harm phrasing the regex banks never anticipated is not capped into invisibility
        by the ceiling. It can only ever raise the outcome, and it is recorded in the reason.
        """
        verdict = verdict if verdict is not None else evaluate_conversation(turns)
        features = featurise(
            np.asarray(probs, dtype=np.float64),
            verdict,
            turns,
            prior_sessions=prior_sessions,
            prior_max_tier_rank=prior_max_tier_rank,
        )
        prediction = self.predict_tier(features)

        t4_override = (
            prediction.tier is Tier.T4
            and prediction.proba[Tier.T4.value] >= config.GATE_HIGH_SCORE
        )
        tier, reason = apply_verdict(
            prediction.tier, verdict, t4_override=t4_override
        )

        return CasePrediction(
            tier=tier,
            model_tier=prediction.tier,
            confidence=prediction.confidence,
            escalation=prediction.escalation,
            proba=prediction.proba,
            verdict=verdict,
            floor_reason=reason,
        )


_CACHED: ConversationHead | None = None


def head() -> ConversationHead:
    """Process-wide singleton. Parsing the artefact per request is pure waste."""
    global _CACHED
    if _CACHED is None:
        _CACHED = ConversationHead.load()
    return _CACHED


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fit", action="store_true", help="refit and write the artefact")
    args = parser.parse_args()

    if args.fit:
        params = fit_and_save()
        print(f"wrote {PARAMS_PATH.relative_to(config.REPO_ROOT)}")
        print(f"  {params['n_train']} conversations, {len(params['feature_names'])} features")
        print(f"  isotonic knots: {len(params['isotonic']['x'])}")
        return

    model = head()
    probs = load_turn_probs()
    conversations = load()

    moved = 0
    correct = 0
    print(f"{'id':<9}{'true':<6}{'model':<7}{'final':<7}{'conf':>6}{'esc':>7}  gate")
    print("-" * 74)
    for convo in conversations:
        case = model.predict_case(np.array(probs[convo.id]), convo.student_turns)
        if case.tier is not case.model_tier:
            moved += 1
        if case.tier is convo.tier:
            correct += 1
        flag = "" if case.tier is case.model_tier else "<- gate"
        print(
            f"{convo.id:<9}{convo.tier.value:<6}{case.model_tier.value:<7}"
            f"{case.tier.value:<7}{case.confidence:>6.2f}{case.escalation:>7.2f}  {flag}"
        )

    print(
        f"\n{correct}/{len(conversations)} exact tier match in-sample "
        f"(NOT a generalisation estimate — see docs/results.md), "
        f"gate moved {moved}"
    )


if __name__ == "__main__":
    main()
