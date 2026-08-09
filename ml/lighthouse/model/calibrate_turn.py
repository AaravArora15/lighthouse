"""Temperature-scale the turn classifier and draw the reliability diagram.

    python -m lighthouse.model.calibrate_turn

Reads ``turn_logits.npz`` written by ``train_turn.py``. Never re-runs inference, and
never touches the model weights: temperature scaling is a single scalar divided into the
logits, fitted by minimising NLL on **val**, and reported on **test**.

Why this step is not optional for Lighthouse. The counsellor queue is sorted by
confidence, and the escalation card prints that confidence to a human who will act on it.
A model that says 0.95 and is right 70% of the time produces a card that lies. Networks
of this size are reliably overconfident after fine-tuning, so the raw softmax is not a
probability, it is a score that happens to live in [0, 1].

Two honest caveats that belong in ``docs/results.md``:

* The model was trained with **class-weighted** cross-entropy, which deliberately
  optimises a reweighted distribution rather than the true one. That is the right call
  for recall on THREAT and SELF_HARM, but it biases the probabilities toward rare classes
  in a way a single scalar cannot fully undo. Expect temperature to improve calibration
  without perfecting it, and read the per-class gaps, not just ECE.
* Temperature scaling cannot change any argmax, so macro-F1 is identical before and
  after by construction. If it moved, something is wrong.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import torch

from lighthouse import config
from lighthouse.eval.metrics import calibration_report, reliability_bins


def softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    z = logits / temperature
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def fit_temperature(logits: np.ndarray, labels: np.ndarray) -> float:
    """Minimise NLL over a single scalar with LBFGS.

    Optimises ``log_t`` rather than ``t`` so the temperature cannot go negative or reach
    zero, which would be a division blow-up rather than a bad fit.
    """
    z = torch.tensor(logits, dtype=torch.float32)
    y = torch.tensor(labels, dtype=torch.long)
    log_t = torch.zeros(1, requires_grad=True)  # t = 1.0 at init, i.e. a no-op

    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=config.TEMPERATURE_MAX_ITER)

    def closure():
        opt.zero_grad()
        loss = torch.nn.functional.cross_entropy(z / log_t.exp(), y)
        loss.backward()
        return loss

    opt.step(closure)
    return float(log_t.exp().item())


def diagram(
    ax, probs: np.ndarray, labels: np.ndarray, title: str, n_bins: int
) -> None:
    """One reliability panel: accuracy per confidence bin against the diagonal."""
    bins = reliability_bins(probs, labels, n_bins)
    width = 1.0 / n_bins
    centres = [b.lo + width / 2 for b in bins]
    acc = [b.accuracy for b in bins]
    conf = [b.mean_confidence for b in bins]
    counts = np.array([b.count for b in bins], dtype=float)

    ax.plot([0, 1], [0, 1], "--", color="#888", lw=1, zorder=1, label="perfect")
    # Gap bars are drawn from accuracy up to confidence, so the visible red area IS the
    # miscalibration. Empty bins draw nothing rather than a misleading zero.
    for c, a, cf, n in zip(centres, acc, conf, counts):
        if n == 0:
            continue
        ax.bar(c, cf - a, bottom=a, width=width * 0.9, color="#d1495b",
               alpha=0.35, edgecolor="#d1495b", lw=0.5, zorder=2)
    ax.bar([c for c, n in zip(centres, counts) if n],
           [a for a, n in zip(acc, counts) if n],
           width=width * 0.9, color="#2e6f95", alpha=0.85, zorder=3, label="accuracy")

    ece = sum(n * abs(b.gap) for b, n in zip(bins, counts)) / max(counts.sum(), 1)
    ax.set_title(f"{title}\nECE = {ece:.4f}", fontsize=10)
    ax.set_xlabel("confidence")
    ax.set_ylabel("accuracy")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_aspect("equal")
    ax.legend(loc="upper left", fontsize=8, frameon=False)


def per_class_gap(probs: np.ndarray, labels: np.ndarray, names: list[str]) -> dict:
    """Mean predicted probability vs actual frequency, per class.

    This is the number the class weighting distorts, and it is invisible in ECE because
    ECE only looks at the top-1 confidence. A class the model systematically over-claims
    shows up here as a positive gap.
    """
    out = {}
    for i, name in enumerate(names):
        claimed = float(probs[:, i].mean())
        actual = float((labels == i).mean())
        out[name] = {
            "mean_prob": claimed,
            "base_rate": actual,
            "gap": claimed - actual,
        }
    return out


def main() -> None:
    path = config.ARTIFACTS_DIR / "turn_logits.npz"
    if not path.exists():
        sys.exit(f"missing {path}\nRun: python -m lighthouse.model.train_turn")

    d = np.load(path, allow_pickle=False)
    val_logits, y_val = d["val_logits"], d["val_labels"]
    test_logits, y_test = d["test_logits"], d["test_labels"]
    names = [str(x) for x in d["label_order"]]
    bins = config.CALIBRATION_BINS

    print(f"val {len(y_val):,} | test {len(y_test):,} | {len(names)} classes | {bins} bins")

    t = fit_temperature(val_logits, y_val)
    print(f"\nfitted temperature (on val): T = {t:.4f}")
    print("  T > 1 means the raw model was overconfident and is being softened.")

    results = {"temperature": t, "bins": bins}
    for split, logits, y in (("val", val_logits, y_val), ("test", test_logits, y_test)):
        raw = softmax(logits, 1.0)
        cal = softmax(logits, t)
        before = calibration_report(raw, y, bins)
        after = calibration_report(cal, y, bins)

        print(f"\n{'=' * 66}\n{split.upper()}")
        print(f"  {'metric':<16}{'before':>12}{'after':>12}{'change':>12}")
        for k in ("ece", "mce", "brier", "nll", "mean_confidence"):
            delta = after[k] - before[k]
            print(f"  {k:<16}{before[k]:>12.4f}{after[k]:>12.4f}{delta:>+12.4f}")
        print(f"  {'accuracy':<16}{before['accuracy']:>12.4f}{after['accuracy']:>12.4f}"
              f"{'  (unchanged by construction)':>12}")

        results[split] = {"before": before, "after": after}
        if split == "test":
            gaps = per_class_gap(cal, y, names)
            results["test_per_class_gap"] = gaps
            print("\n  per-class mean probability vs base rate (post-calibration)")
            print(f"  {'class':<18}{'mean prob':>12}{'base rate':>12}{'gap':>10}")
            for name, g in gaps.items():
                print(f"  {name:<18}{g['mean_prob']:>12.4f}{g['base_rate']:>12.4f}"
                      f"{g['gap']:>+10.4f}")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(1, 2, figsize=(9, 4.6))
        diagram(axes[0], softmax(test_logits, 1.0), y_test, "Raw (uncalibrated)", bins)
        diagram(axes[1], softmax(test_logits, t), y_test, f"Temperature-scaled (T={t:.3f})", bins)
        fig.suptitle("Turn classifier reliability, test split", fontsize=11)
        fig.tight_layout()
        out = config.ARTIFACTS_DIR / "reliability_turn.png"
        fig.savefig(out, dpi=160)
        print(f"\nwrote {out.relative_to(config.REPO_ROOT)}")
    except ImportError:
        print("\nmatplotlib not installed, skipping the diagram")

    out = config.ARTIFACTS_DIR / "turn_calibration.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"wrote {out.relative_to(config.REPO_ROOT)}")
    print(f"\nHEADLINE: test ECE {results['test']['before']['ece']:.4f} -> "
          f"{results['test']['after']['ece']:.4f} at T={t:.3f}")


if __name__ == "__main__":
    sys.exit(main())
