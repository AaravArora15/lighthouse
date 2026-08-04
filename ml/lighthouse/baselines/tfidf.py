"""TF-IDF + logistic regression baseline for turn-level harm classification.

    python -m lighthouse.baselines.tfidf

This is the number DistilBERT has to beat on day 2. It exists so that "we fine-tuned a
transformer" is a claim with evidence behind it rather than an assumption: if a linear
model on character and word n-grams gets within a point of the transformer, the
transformer is not earning its deployment cost and we should say so.

Reports macro-F1 **and** the per-class breakdown. Macro-F1 alone is misleading here: the
THREAT class has ~70 test examples, so its F1 moves in visible jumps and swings the macro
average around far more than it deserves.
"""

from __future__ import annotations

import json
import sys
import time

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    f1_score,
)
from sklearn.pipeline import make_pipeline, make_union

from lighthouse import config
from lighthouse.taxonomy import HARM_ORDER


def load_split(name: str) -> pd.DataFrame:
    path = config.SPLITS_DIR / f"turns_{name}.parquet"
    if not path.exists():
        sys.exit(
            f"missing {path}\nRun: python -m lighthouse.data.build_splits"
        )
    return pd.read_parquet(path)


def build_model() -> object:
    """Word n-grams catch phrasing, char n-grams catch obfuscation and misspelling.

    Char n-grams matter more than usual in this domain: harassment is routinely spelled
    around filters, and a purely word-level model misses it.
    """
    features = make_union(
        TfidfVectorizer(
            analyzer="word",
            ngram_range=(1, 2),
            min_df=2,
            max_features=200_000,
            sublinear_tf=True,
            strip_accents="unicode",
        ),
        TfidfVectorizer(
            analyzer="char_wb",
            ngram_range=(3, 5),
            min_df=3,
            max_features=200_000,
            sublinear_tf=True,
        ),
    )
    clf = LogisticRegression(
        max_iter=2000,
        C=4.0,
        class_weight=config.CLASS_WEIGHTING,
    )
    return make_pipeline(features, clf)


def print_confusion(y_true, y_pred, labels: list[str]) -> None:
    cm = confusion_matrix(y_true, y_pred, labels=labels)
    width = max(len(x) for x in labels) + 2
    print(f"\n  confusion matrix (rows = true, cols = predicted)")
    print(" " * (width + 2) + "".join(f"{l[:7]:>9}" for l in labels))
    for label, row in zip(labels, cm):
        print(f"  {label:<{width}}" + "".join(f"{v:>9,}" for v in row))


def main() -> None:
    labels = [h.value for h in HARM_ORDER]

    train, val, test = (load_split(n) for n in ("train", "val", "test"))
    print(f"train {len(train):,} | val {len(val):,} | test {len(test):,}")

    model = build_model()

    print("\nfitting TF-IDF + LogReg ...", flush=True)
    t0 = time.time()
    model.fit(train["text"], train["harm"])
    print(f"  fit in {time.time() - t0:.1f}s")

    results: dict[str, dict] = {}
    for name, part in (("val", val), ("test", test)):
        pred = model.predict(part["text"])
        macro = f1_score(part["harm"], pred, average="macro", labels=labels, zero_division=0)
        weighted = f1_score(
            part["harm"], pred, average="weighted", labels=labels, zero_division=0
        )
        print(f"\n{'=' * 62}\n{name.upper()}  macro-F1 = {macro:.4f}   weighted-F1 = {weighted:.4f}")
        print(
            classification_report(
                part["harm"], pred, labels=labels, digits=3, zero_division=0
            )
        )
        if name == "test":
            print_confusion(part["harm"], pred, labels)

        report = classification_report(
            part["harm"], pred, labels=labels, output_dict=True, zero_division=0
        )
        results[name] = {
            "macro_f1": float(macro),
            "weighted_f1": float(weighted),
            "per_class_f1": {l: float(report[l]["f1-score"]) for l in labels},
            "support": {l: int(report[l]["support"]) for l in labels},
        }

    # The metric a school actually cares about: of the turns that carry real risk, how
    # many did we catch at all? Confusing HARASSMENT with IDENTITY_ATTACK costs little.
    # Calling a SELF_HARM turn benign costs everything.
    pred_test = model.predict(test["text"])
    risky = {"self_harm", "threat"}
    true_risky = test["harm"].isin(risky).to_numpy()
    pred_risky = pd.Series(pred_test).isin(risky).to_numpy()
    caught = int((true_risky & pred_risky).sum())
    total = int(true_risky.sum())
    missed_as_benign = int(
        (true_risky & (pd.Series(pred_test) == "none").to_numpy()).sum()
    )
    print(f"\n{'=' * 62}")
    print("SAFETY VIEW (self_harm + threat treated as one 'must not miss' bucket)")
    print(f"  recall into the risky bucket : {caught}/{total} = {caught / total:.3f}")
    print(f"  missed entirely as 'none'    : {missed_as_benign}/{total} = "
          f"{missed_as_benign / total:.3f}")
    results["safety_view"] = {
        "risky_bucket_recall": caught / total,
        "missed_as_none_rate": missed_as_benign / total,
        "risky_total": total,
    }

    config.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    out = config.ARTIFACTS_DIR / "baseline_tfidf.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out.relative_to(config.REPO_ROOT)}")
    print(f"\nHEADLINE: TF-IDF baseline test macro-F1 = {results['test']['macro_f1']:.4f}")


if __name__ == "__main__":
    sys.exit(main())
