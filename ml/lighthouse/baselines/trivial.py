"""Label-only baselines: the floor any real model has to clear.

    python -m lighthouse.baselines.trivial

Two strategies, neither of which reads the text at all:

* **most_frequent** — always predict the majority class. This is the number that exposes
  accuracy as a vanity metric on this corpus: `none` is 37.8% of the test split, so a
  model that says "none" to everything scores 0.378 accuracy while catching zero of the
  1,870 risky turns. Its macro-F1 collapses to ~0.09, which is the point.
* **stratified** — sample predictions from the training label distribution. A random
  model that happens to have the right marginals.

These are not competitors. They exist so `docs/results.md` can state a floor, and so the
TF-IDF number (0.7148) is legible as "far above chance" rather than an unanchored decimal.
Deliberately has no `ANTHROPIC_API_KEY` dependency: the zero-shot Claude baseline is the
*other* comparator on day 2 and it is blocked without a key, so this file is what keeps
the day 2 gate reachable offline.
"""

from __future__ import annotations

import json
import sys

import numpy as np
from sklearn.dummy import DummyClassifier
from sklearn.metrics import classification_report, f1_score

from lighthouse import config
from lighthouse.baselines.tfidf import load_split
from lighthouse.taxonomy import HARM_ORDER

STRATEGIES = ("most_frequent", "stratified")

RISKY = {"self_harm", "threat"}


def evaluate(strategy: str, train, part) -> dict:
    """Fit on the train labels only, predict on ``part``. No text is ever read."""
    # DummyClassifier still wants an X of the right length; the values are ignored.
    clf = DummyClassifier(strategy=strategy, random_state=config.SEED)
    clf.fit(np.zeros((len(train), 1)), train["harm"])
    pred = clf.predict(np.zeros((len(part), 1)))

    labels = [h.value for h in HARM_ORDER]
    report = classification_report(
        part["harm"], pred, labels=labels, output_dict=True, zero_division=0
    )

    true_risky = part["harm"].isin(RISKY).to_numpy()
    pred_risky = np.isin(pred, list(RISKY))
    total = int(true_risky.sum())

    return {
        "macro_f1": float(
            f1_score(part["harm"], pred, average="macro", labels=labels, zero_division=0)
        ),
        "weighted_f1": float(
            f1_score(
                part["harm"], pred, average="weighted", labels=labels, zero_division=0
            )
        ),
        "accuracy": float((pred == part["harm"].to_numpy()).mean()),
        "per_class_f1": {label: float(report[label]["f1-score"]) for label in labels},
        "risky_bucket_recall": float((true_risky & pred_risky).sum() / total),
    }


def main() -> None:
    train, val, test = (load_split(n) for n in ("train", "val", "test"))
    print(f"train {len(train):,} | val {len(val):,} | test {len(test):,}\n")

    results: dict[str, dict] = {}
    for strategy in STRATEGIES:
        results[strategy] = {
            split: evaluate(strategy, train, part)
            for split, part in (("val", val), ("test", test))
        }
        t = results[strategy]["test"]
        print(f"{strategy:>14}  test macro-F1 {t['macro_f1']:.4f}   "
              f"accuracy {t['accuracy']:.4f}   risky recall {t['risky_bucket_recall']:.3f}")

    config.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    out = config.ARTIFACTS_DIR / "baseline_trivial.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out.relative_to(config.REPO_ROOT)}")

    floor = max(results[s]["test"]["macro_f1"] for s in STRATEGIES)
    print(f"\nHEADLINE: best label-only test macro-F1 = {floor:.4f}")


if __name__ == "__main__":
    sys.exit(main())
