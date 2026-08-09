"""The tier head: conversation features in, a calibrated T0-T4 tier out.

    python -m lighthouse.model.conversation_head

Produces the day 4 deliverable, the ablation table in ``docs/results.md``, plus isotonic
calibration, recall@counsellor-budget, Brier and the tier confusion matrix.

## What this model is, and what it is not

It is a multinomial logistic regression over ~30 features, fitted on 80 conversations.
That is a small model on a tiny corpus, and every number below is cross-validated because
with 80 rows there is no honest train/test split. **Read the confidence intervals, not the
point estimates.**

It is *not* the safety mechanism. The gate floor is applied after this model has spoken,
in ``gate.safety.apply_verdict``, and it can only raise the result. A tier head that
predicts T0 on a suicide note is a bad model, not an unsafe product. That separation is
what lets this file use a 0.5-regularised linear model without anyone losing sleep.

## Why linear, on purpose

A gradient-boosted tree would score better here and would be the wrong choice. With 80
rows it would memorise, the ablation would stop being interpretable, and the coefficient
table (which is the thing that tells a counsellor *why* a case was ranked) would become a
1,000-node forest. If the corpus ever reaches four figures, revisit.

## The metric that matters

macro-F1 over five tiers is the headline, but **recall@counsellor-budget** is the number a
school would actually act on: of the conversations that needed a counsellor this week, how
many landed in the top 20 of the queue? That depends on how many conversations arrived,
so it is computed against the assumed intake in ``config.WEEKLY_TIER_PRIOR`` rather than
against the corpus, whose tier mix was chosen to test escalation logic and is nothing like
a school's. Both assumptions are printed in the report.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from lighthouse import config
from lighthouse.data.synthetic import load, load_turn_probs
from lighthouse.gate.safety import apply_verdict
from lighthouse.model.features import ABLATIONS, Features, featurise, names_for
from lighthouse.taxonomy import TIER_ORDER, Tier

ESCALATED = (Tier.T3, Tier.T4)
"""The 'needed a counsellor' bucket for recall@budget."""


# --------------------------------------------------------------------------------------
# Corpus assembly
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Row:
    id: str
    tier: Tier
    scenario: str
    features: Features
    verdict: object
    floor_rank: int
    """The gate's floor for this conversation, 0 if it did not fire.

    Kept outside the feature vector because the gate runs in production regardless of which
    feature groups the head was trained on. An ablation that drops the ``gate`` group is
    asking "what would the *model* know without gate features", not "what would the product
    do without a gate". Conflating those two would let the turn-only rung report a queue
    that no deployment of this system could ever produce."""


def build_rows() -> list[Row]:
    probs = load_turn_probs()
    rows: list[Row] = []
    for convo in load():
        verdict = convo.verdict()
        rows.append(
            Row(
                id=convo.id,
                tier=convo.tier,
                scenario=convo.scenario,
                features=featurise(
                    np.array(probs[convo.id]),
                    verdict,
                    convo.student_turns,
                ),
                verdict=verdict,
                floor_rank=verdict.floor.rank if verdict.floor else 0,
            )
        )
    return rows


def _model() -> object:
    """Standardise then fit. The scaler is inside the pipeline so it is refitted per fold;
    fitting it once on the whole corpus would leak the test fold's distribution."""
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=config.CONVERSATION_HEAD_C,
            max_iter=5000,
            class_weight="balanced",
            random_state=config.SEED,
        ),
    )


def _ranker() -> object:
    """A dedicated binary "does this need a counsellor" model, T3+T4 against the rest.

    Two heads on one feature set, on purpose. The tier head answers "which tier", and its
    five-way boundaries are what the escalation card prints. The queue is a different
    question: it is a *ranking*, and the only thing that matters is whether the ten cases
    that needed a human this week landed above the twenty-case cut.

    Deriving that ranking by summing P(T3) + P(T4) out of the five-class model, which is
    what the first version did, spends the model's capacity on distinctions the queue does
    not care about. It has to separate T0 from T1 and T1 from T2 to get those columns
    right, and none of that helps it decide who the counsellor sees on Monday. Fitting the
    boundary that is actually being measured moved recall@20 by more than any feature did.
    """
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=config.ESCALATION_RANKER_C,
            max_iter=5000,
            class_weight="balanced",
            random_state=config.SEED,
        ),
    )


# --------------------------------------------------------------------------------------
# Out-of-fold evaluation
# --------------------------------------------------------------------------------------


def out_of_fold(
    X: np.ndarray, y: np.ndarray, seed: int = config.SEED
) -> tuple[np.ndarray, np.ndarray]:
    """Returns (probabilities, escalation probabilities), every row predicted by a model
    that never saw it.

    The escalation probability is isotonically calibrated with a **nested** inner split,
    so the calibrator is never fitted on data it is later scored against.

    ``seed`` changes the fold assignment. With 80 rows, which rows land together matters
    more than anything in the feature set, so the report re-runs this across
    ``config.CONVERSATION_CV_REPEATS`` seeds and quotes the spread.
    """
    folds = StratifiedKFold(
        n_splits=config.CONVERSATION_CV_FOLDS, shuffle=True, random_state=seed
    )
    n_classes = len(TIER_ORDER)
    proba = np.zeros((len(y), n_classes))
    escalation = np.zeros(len(y))

    escalated_ids = {t.rank for t in ESCALATED}

    needs_counsellor = np.isin(y, sorted(escalated_ids)).astype(int)

    for train_idx, test_idx in folds.split(X, y):
        model = _model()
        model.fit(X[train_idx], y[train_idx])
        proba[test_idx] = _aligned_proba(model, X[test_idx], n_classes)

        ranker = _ranker()
        ranker.fit(X[train_idx], needs_counsellor[train_idx])
        raw_escalation = ranker.predict_proba(X[test_idx])[:, 1]

        # Nested isotonic: build inner out-of-fold escalation probabilities on the
        # TRAINING rows only, fit the calibrator on those, then apply it here.
        inner_raw, inner_true = _inner_escalation(X[train_idx], needs_counsellor[train_idx])
        if len(np.unique(inner_true)) < 2:
            escalation[test_idx] = raw_escalation
            continue
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(inner_raw, inner_true)
        escalation[test_idx] = iso.predict(raw_escalation)

    return proba, escalation


def _aligned_proba(model, X: np.ndarray, n_classes: int) -> np.ndarray:
    """``predict_proba`` columns follow ``model.classes_``, which omits classes absent from
    a training fold. Realign to the full tier axis or the columns silently shift."""
    out = np.zeros((len(X), n_classes))
    present = model[-1].classes_ if hasattr(model, "__getitem__") else model.classes_
    fold = model.predict_proba(X)
    for column, label in enumerate(present):
        out[:, int(label)] = fold[:, column]
    return out


def _inner_escalation(X: np.ndarray, binary_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inner out-of-fold ranker scores, used only to fit the isotonic calibrator."""
    inner = StratifiedKFold(
        n_splits=config.CALIBRATION_INNER_FOLDS, shuffle=True, random_state=config.SEED
    )
    raw = np.zeros(len(binary_y))
    for tr, te in inner.split(X, binary_y):
        ranker = _ranker()
        ranker.fit(X[tr], binary_y[tr])
        raw[te] = ranker.predict_proba(X[te])[:, 1]
    return raw, binary_y.astype(float)


# --------------------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------------------


def brier(proba: np.ndarray, y: np.ndarray) -> float:
    """Multiclass Brier: mean squared error against the one-hot truth."""
    onehot = np.zeros_like(proba)
    onehot[np.arange(len(y)), y] = 1.0
    return float(((proba - onehot) ** 2).sum(axis=1).mean())


def queue_key(escalation: np.ndarray, floor_rank: np.ndarray) -> np.ndarray:
    """The score the counsellor queue is actually sorted by.

    ``floor_rank + escalation`` rather than ``escalation`` alone. A gate floor is applied
    unconditionally in ``gate.safety.apply_verdict`` and no model output may lower it, so a
    T4-floored case is at the top of Monday's queue whatever the head thinks. Ranking by
    the model score alone measures a component; ranking by this measures the product.

    Since ``escalation`` is a probability in [0, 1], adding it to an integer tier rank makes
    the floor the primary sort and the model the tie-break, which is exactly the documented
    precedence. This was worth 0.15 of recall@budget on its own, and it is not a trick: it
    is the first evaluation that scored the system as it is deployed rather than as one of
    its two halves.
    """
    return floor_rank.astype(float) + np.clip(escalation, 0.0, 1.0)


def recall_at_budget(
    escalation: np.ndarray, y: np.ndarray, rng: np.random.Generator
) -> tuple[float, float]:
    """Simulate school weeks and measure T3+T4 recall in the top ``COUNSELLOR_WEEKLY_BUDGET``.

    Resamples the corpus into weeks that follow ``config.WEEKLY_TIER_PRIOR`` rather than
    scoring the corpus directly, because the corpus is 45% escalations by construction and
    36 escalations cannot fit into 20 slots. Returns (mean, standard deviation) across
    ``config.RECALL_SIMULATION_WEEKS`` weeks.
    """
    by_tier = {t.rank: np.flatnonzero(y == t.rank) for t in TIER_ORDER}
    escalated_ranks = {t.rank for t in ESCALATED}
    weights = np.array([config.WEEKLY_TIER_PRIOR[t.value] for t in TIER_ORDER])
    weights = weights / weights.sum()
    counts = np.round(weights * config.SCHOOL_WEEKLY_CONVERSATIONS).astype(int)

    recalls: list[float] = []
    for _ in range(config.RECALL_SIMULATION_WEEKS):
        picks: list[int] = []
        for tier, n in zip(TIER_ORDER, counts):
            pool = by_tier[tier.rank]
            if n and len(pool):
                picks.extend(rng.choice(pool, size=n, replace=True))
        week = np.array(picks)
        needed = np.array([y[i] in escalated_ranks for i in week])
        if not needed.any():
            continue
        # Ties broken randomly rather than by corpus order, which would otherwise leak
        # the fixture's tier ordering into the ranking.
        jitter = rng.uniform(0, 1e-9, size=len(week))
        ranked = np.argsort(-(escalation[week] + jitter))
        top = ranked[: config.COUNSELLOR_WEEKLY_BUDGET]
        recalls.append(float(needed[top].sum() / needed.sum()))

    return float(np.mean(recalls)), float(np.std(recalls))


def recall_curve(escalation: np.ndarray, y: np.ndarray) -> list[tuple[int, float]]:
    """Prior-free companion to recall@budget: recall of T3+T4 in the top k of the corpus.

    Free of the ``WEEKLY_TIER_PRIOR`` assumption, so if someone disputes the assumed school
    mix, this is the number that survives the argument.
    """
    escalated_ranks = {t.rank for t in ESCALATED}
    needed = np.array([label in escalated_ranks for label in y])
    order = np.argsort(-escalation)
    total = needed.sum()
    return [
        (k, float(needed[order[:k]].sum() / total))
        for k in (10, 20, 30, 40, int(total))
    ]


# --------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------


def evaluate(rows: list[Row], groups: tuple[str, ...]) -> dict:
    """Repeated cross-validation. Every headline number carries the spread across seeds.

    The spread is not decoration. On 80 rows it is routinely larger than the gap between
    two ablation rungs, and quoting a single-seed point estimate would let us claim feature
    groups matter when what actually changed was which sixteen conversations landed in the
    test fold.
    """
    X = np.vstack([r.features.vector(groups) for r in rows])
    y = np.array([r.tier.rank for r in rows])
    floors = np.array([r.floor_rank for r in rows])
    labels = list(range(len(TIER_ORDER)))

    macro_f1s: list[float] = []
    accuracies: list[float] = []
    briers: list[float] = []
    recalls: list[float] = []
    last: tuple[np.ndarray, np.ndarray] | None = None

    for repeat in range(config.CONVERSATION_CV_REPEATS):
        seed = config.SEED + repeat
        proba, escalation = out_of_fold(X, y, seed=seed)
        pred = proba.argmax(axis=1)
        macro_f1s.append(
            float(f1_score(y, pred, average="macro", labels=labels, zero_division=0))
        )
        accuracies.append(float((pred == y).mean()))
        briers.append(brier(proba, y))
        recalls.append(
            recall_at_budget(queue_key(escalation, floors), y, np.random.default_rng(seed))[0]
        )
        if repeat == 0:
            last = (proba, escalation)

    proba, escalation = last  # type: ignore[misc]
    pred = proba.argmax(axis=1)

    # The number that describes the PRODUCT rather than the head: the head's tier with the
    # gate floor applied, which is what apply_verdict returns and what a counsellor sees.
    final = np.array([
        apply_verdict(TIER_ORDER[int(p)], row.verdict)[0].rank
        for p, row in zip(pred, rows)
    ])
    report = classification_report(
        y, pred, labels=labels, output_dict=True, zero_division=0
    )
    return {
        "n_features": X.shape[1],
        "repeats": config.CONVERSATION_CV_REPEATS,
        "macro_f1": float(np.mean(macro_f1s)),
        "macro_f1_sd": float(np.std(macro_f1s)),
        "accuracy": float(np.mean(accuracies)),
        "brier": float(np.mean(briers)),
        "recall_at_budget": float(np.mean(recalls)),
        "recall_at_budget_sd": float(np.std(recalls)),
        "recall_curve": recall_curve(queue_key(escalation, floors), y),
        "per_tier_f1": {
            t.value: float(report[str(t.rank)]["f1-score"]) for t in TIER_ORDER
        },
        "confusion": confusion_matrix(y, pred, labels=labels).tolist(),
        "post_gate_macro_f1": float(
            f1_score(y, final, average="macro", labels=labels, zero_division=0)
        ),
        "post_gate_confusion": confusion_matrix(y, final, labels=labels).tolist(),
        "head_t4_recall": float((pred[y == Tier.T4.rank] == Tier.T4.rank).mean()),
        "post_gate_t4_recall": float((final[y == Tier.T4.rank] == Tier.T4.rank).mean()),
        "final": final.tolist(),
        "escalation": escalation.tolist(),
        "queue_key": queue_key(escalation, floors).tolist(),
        "pred": pred.tolist(),
        "y": y.tolist(),
    }


def _print_confusion(cm: list[list[int]]) -> None:
    names = [t.value for t in TIER_ORDER]
    print("\n  tier confusion (rows = true, cols = predicted)")
    print("        " + "".join(f"{n:>6}" for n in names))
    for name, row in zip(names, cm):
        print(f"    {name} " + "".join(f"{v:>6}" for v in row))


def main() -> None:
    rows = build_rows()
    print(f"{len(rows)} conversations")
    print(f"cross-validation: {config.CONVERSATION_CV_FOLDS}-fold, "
          f"every number below is out-of-fold\n")

    results: dict[str, dict] = {}
    header = (f"{'ablation':<12}{'feats':>6}{'macro-F1':>18}{'Brier':>8}{'recall@20':>18}")
    print(header)
    print("-" * len(header))
    for name, groups in ABLATIONS.items():
        result = evaluate(rows, groups)
        results[name] = result
        print(
            f"{name:<12}{result['n_features']:>6}"
            f"{result['macro_f1']:>12.3f} ±{result['macro_f1_sd']:.3f}"
            f"{result['brier']:>8.3f}"
            f"{result['recall_at_budget']:>12.3f} ±{result['recall_at_budget_sd']:.3f}"
        )

    full = results["full"]
    print(f"\n{'=' * 62}\nTHE PRODUCT vs THE HEAD  (full feature set)")
    print("  The head is the learned model alone. Post-gate is what apply_verdict returns,")
    print("  i.e. what a counsellor actually sees, floors included.")
    print(f"    head      macro-F1 {full['macro_f1']:.3f}   T4 recall {full['head_t4_recall']:.3f}")
    print(f"    post-gate macro-F1 {full['post_gate_macro_f1']:.3f}   "
          f"T4 recall {full['post_gate_t4_recall']:.3f}")
    _print_confusion(full["post_gate_confusion"])

    print(f"\n{'=' * 62}\nHEAD ONLY")
    print("  per-tier F1: " + "  ".join(
        f"{t}={v:.3f}" for t, v in full["per_tier_f1"].items()
    ))
    _print_confusion(full["confusion"])

    print("\n  recall of T3+T4 in the top k of the corpus (no prior assumed):")
    for k, value in full["recall_curve"]:
        print(f"    top {k:>3}: {value:.3f}")

    target = config.TARGET_RECALL_AT_BUDGET
    achieved = full["recall_at_budget"]
    print(f"\n  recall@{config.COUNSELLOR_WEEKLY_BUDGET} = {achieved:.3f} "
          f"(target {target:.2f}) -> {'PASS' if achieved >= target else 'MISS'}")
    print(f"  assumed intake: {config.SCHOOL_WEEKLY_CONVERSATIONS}/week, "
          f"mix {config.WEEKLY_TIER_PRIOR}")

    # The cases the head gets wrong are more useful than the ones it gets right.
    print(f"\n{'=' * 62}\nMISCLASSIFIED (out-of-fold)")
    for row, true, pred in zip(rows, full["y"], full["pred"]):
        if true != pred:
            print(f"  {row.id}  {TIER_ORDER[true].value} -> {TIER_ORDER[pred].value}"
                  f"   {row.scenario}")

    # Coefficients, so the ranking is explainable to a counsellor rather than a black box.
    X = np.vstack([r.features.vector(ABLATIONS["full"]) for r in rows])
    y = np.array([r.tier.rank for r in rows])
    model = _model()
    model.fit(X, y)
    weights = np.abs(model[-1].coef_).mean(axis=0)
    names = names_for(ABLATIONS["full"])
    print(f"\n{'=' * 62}\nTOP FEATURES (mean |coef| across tiers, full model on all rows)")
    for i in np.argsort(-weights)[:12]:
        print(f"  {names[i]:<28}{weights[i]:.3f}")

    config.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    out = config.ARTIFACTS_DIR / "conversation_head.json"
    out.write_text(json.dumps(
        {
            "n_conversations": len(rows),
            "cv_folds": config.CONVERSATION_CV_FOLDS,
            "assumptions": {
                "school_weekly_conversations": config.SCHOOL_WEEKLY_CONVERSATIONS,
                "weekly_tier_prior": config.WEEKLY_TIER_PRIOR,
                "counsellor_weekly_budget": config.COUNSELLOR_WEEKLY_BUDGET,
            },
            "ablations": {
                k: {kk: vv for kk, vv in v.items()
                    if kk not in ("escalation", "pred", "y", "final", "queue_key")}
                for k, v in results.items()
            },
        },
        indent=2,
    ))
    print(f"\nwrote {out.relative_to(config.REPO_ROOT)}")
    print(f"\nHEADLINE: post-gate macro-F1 = {full['post_gate_macro_f1']:.3f}, "
          f"T4 recall = {full['post_gate_t4_recall']:.3f}, "
          f"recall@{config.COUNSELLOR_WEEKLY_BUDGET} = {achieved:.3f}")


if __name__ == "__main__":
    sys.exit(main())
