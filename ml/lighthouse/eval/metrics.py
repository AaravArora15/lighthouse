"""Shared evaluation metrics. Used by the turn classifier today, the conversation head
on day 4, and the ablation table in ``docs/results.md``.

Two families live here:

* **Discrimination** — macro-F1, per-class F1, confusion matrices. Answers "does the
  model separate the classes."
* **Calibration** — ECE, Brier, reliability bins. Answers "when the model says 0.8, is it
  right 80% of the time." This is the half that actually matters for Lighthouse: a
  counsellor queue sorted by confidence is only honest if the confidence means something.
  An uncalibrated model that ranks well still produces a card that lies to a human.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


# --------------------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ReliabilityBin:
    lo: float
    hi: float
    count: int
    mean_confidence: float
    accuracy: float

    @property
    def gap(self) -> float:
        """Signed miscalibration. Positive = overconfident."""
        return self.mean_confidence - self.accuracy


def reliability_bins(
    probs: np.ndarray, labels: np.ndarray, n_bins: int
) -> list[ReliabilityBin]:
    """Equal-width bins over top-1 confidence.

    ``probs`` is (n, n_classes) post-softmax; ``labels`` is (n,) integer class ids.
    Empty bins are returned with ``count=0`` so the diagram keeps its x-axis honest
    rather than silently closing the gap.
    """
    confidence = probs.max(axis=1)
    correct = probs.argmax(axis=1) == labels
    edges = np.linspace(0.0, 1.0, n_bins + 1)

    out: list[ReliabilityBin] = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        # Left-open intervals, except the first, so confidence exactly 0 lands somewhere.
        mask = (confidence > lo) & (confidence <= hi) if lo > 0 else (confidence <= hi)
        n = int(mask.sum())
        out.append(
            ReliabilityBin(
                lo=float(lo),
                hi=float(hi),
                count=n,
                mean_confidence=float(confidence[mask].mean()) if n else 0.0,
                accuracy=float(correct[mask].mean()) if n else 0.0,
            )
        )
    return out


def expected_calibration_error(
    probs: np.ndarray, labels: np.ndarray, n_bins: int
) -> float:
    """Support-weighted mean absolute gap between confidence and accuracy."""
    bins = reliability_bins(probs, labels, n_bins)
    total = sum(b.count for b in bins)
    if total == 0:
        return 0.0
    return sum(b.count * abs(b.gap) for b in bins) / total


def max_calibration_error(probs: np.ndarray, labels: np.ndarray, n_bins: int) -> float:
    """Worst gap over any bin holding at least 1% of the data.

    ECE hides a badly broken bin behind well-populated good ones. MCE is the number that
    catches "the model is fine except when it is very confident", which is exactly the
    failure mode that would put a wrong T4 at the top of a counsellor's queue.
    """
    bins = reliability_bins(probs, labels, n_bins)
    total = sum(b.count for b in bins)
    if total == 0:
        return 0.0
    floor = max(1, int(0.01 * total))
    populated = [b for b in bins if b.count >= floor]
    return max((abs(b.gap) for b in populated), default=0.0)


def brier_score(probs: np.ndarray, labels: np.ndarray) -> float:
    """Multiclass Brier score: mean squared error against the one-hot target.

    Lower is better. Unlike ECE this is a proper scoring rule, so it cannot be gamed by
    a model that is well calibrated but uninformative.
    """
    n, k = probs.shape
    onehot = np.zeros_like(probs)
    onehot[np.arange(n), labels] = 1.0
    return float(((probs - onehot) ** 2).sum(axis=1).mean())


def negative_log_likelihood(probs: np.ndarray, labels: np.ndarray) -> float:
    p = np.clip(probs[np.arange(len(labels)), labels], 1e-12, 1.0)
    return float(-np.log(p).mean())


def calibration_report(
    probs: np.ndarray, labels: np.ndarray, n_bins: int
) -> dict[str, float]:
    return {
        "ece": expected_calibration_error(probs, labels, n_bins),
        "mce": max_calibration_error(probs, labels, n_bins),
        "brier": brier_score(probs, labels),
        "nll": negative_log_likelihood(probs, labels),
        "mean_confidence": float(probs.max(axis=1).mean()),
        "accuracy": float((probs.argmax(axis=1) == labels).mean()),
    }


# --------------------------------------------------------------------------------------
# Domain-specific views
# --------------------------------------------------------------------------------------


def safety_view(
    pred_labels: np.ndarray,
    true_labels: np.ndarray,
    risky_ids: set[int],
    benign_id: int,
) -> dict[str, float]:
    """The metric a school actually cares about.

    Confusing HARASSMENT with IDENTITY_ATTACK costs a counsellor nothing: both queue.
    Calling a SELF_HARM turn benign costs everything. So collapse the risky classes into
    one must-not-miss bucket and report two numbers: how many risky turns land anywhere
    in the bucket, and how many are missed *entirely* as benign.
    """
    true_risky = np.isin(true_labels, list(risky_ids))
    pred_risky = np.isin(pred_labels, list(risky_ids))
    total = int(true_risky.sum())
    if total == 0:
        return {"risky_bucket_recall": 0.0, "missed_as_none_rate": 0.0, "risky_total": 0}
    caught = int((true_risky & pred_risky).sum())
    missed = int((true_risky & (pred_labels == benign_id)).sum())
    return {
        "risky_bucket_recall": caught / total,
        "missed_as_none_rate": missed / total,
        "risky_total": total,
    }


def confusion_pair(
    pred_labels: np.ndarray, true_labels: np.ndarray, a: int, b: int
) -> dict[str, int]:
    """Directional confusion counts for one label pair.

    Exists because of the day 1 finding: the dominant error is DISTRESS vs SELF_HARM in
    both directions, and it is the boundary the whole T4 decision turns on. Tracking it
    as a named number stops it disappearing into a macro average.
    """
    return {
        "a_as_b": int(((true_labels == a) & (pred_labels == b)).sum()),
        "b_as_a": int(((true_labels == b) & (pred_labels == a)).sum()),
        "a_total": int((true_labels == a).sum()),
        "b_total": int((true_labels == b).sum()),
    }


def format_confusion(cm: np.ndarray, labels: list[str]) -> str:
    width = max(len(x) for x in labels) + 2
    lines = ["  confusion matrix (rows = true, cols = predicted)"]
    lines.append(" " * (width + 2) + "".join(f"{l[:7]:>9}" for l in labels))
    for label, row in zip(labels, cm):
        lines.append(f"  {label:<{width}}" + "".join(f"{v:>9,}" for v in row))
    return "\n".join(lines)
