"""Normalise the source datasets into one turn-level corpus and build the splits.

    python -m lighthouse.data.build_splits

Design notes that matter for the results:

* **Dedupe before splitting.** Near-duplicate posts across sources would otherwise land on
  both sides of the train/test boundary and inflate every number we report. Dedupe is on a
  normalised text hash across the whole corpus, before any split is drawn.
* **Cap per class, per source.** The raw corpus is ~510k rows and wildly imbalanced
  (SELF_HARM is plentiful, THREAT is not). Capping keeps training tractable on a laptop
  and keeps the imbalance in a range class weighting can actually fix.
* **Stratify on the harm label** so every split sees every class, including the scarce ones.
* **Fixed seed** from ``config.SEED``. Never randomise per run.
"""

from __future__ import annotations

import hashlib
import re
import sys
from collections import Counter

import pandas as pd
from sklearn.model_selection import train_test_split

from lighthouse import config
from lighthouse.data.mapping import SOURCES, Source
from lighthouse.taxonomy import HARM_ORDER, Harm

#: Cap per (source, harm) pair. THREAT is nowhere near this, which is the point of
#: reporting per-class support honestly rather than hiding it behind a macro average.
PER_CLASS_CAP = 12_000

_WS = re.compile(r"\s+")
_URL = re.compile(r"https?://\S+|www\.\S+")
_USER = re.compile(r"@\w+")


def clean_text(raw: str) -> str:
    """Light normalisation only.

    Deliberately conservative: we do not lowercase, strip punctuation, or remove stop
    words. The downstream model is a cased-agnostic transformer that benefits from
    ALL-CAPS SHOUTING and punctuation as harm signal, and the TF-IDF baseline should be
    compared on the same text the transformer sees.
    """
    text = _URL.sub(" [URL] ", raw)
    text = _USER.sub(" [USER] ", text)
    text = text.replace("\\n", " ").replace("\n", " ")
    text = _WS.sub(" ", text).strip()
    return text[: config.MAX_TURN_CHARS]


def norm_key(text: str) -> str:
    """Aggressive normalisation, used ONLY for dedupe, never for training."""
    k = _WS.sub(" ", text.lower().strip())
    k = re.sub(r"[^a-z0-9 ]", "", k)
    return hashlib.sha1(k.encode()).hexdigest()


def load_source(src: Source) -> pd.DataFrame:
    from datasets import load_dataset

    print(f"  loading {src.hf_id} ...", flush=True)
    ds = load_dataset(src.hf_id, split=src.split)

    rows: list[dict] = []
    dropped = 0
    for row in ds:
        harm = src.to_harm(row)
        if harm is None:
            dropped += 1
            continue
        text = clean_text(str(row.get(src.text_column, "")))
        if len(text) < config.MIN_TURN_CHARS:
            dropped += 1
            continue
        rows.append({"text": text, "harm": harm.value, "source": src.key})

    df = pd.DataFrame(rows)
    print(f"    kept {len(df):,}  dropped {dropped:,}")
    print(f"    {dict(Counter(df['harm']).most_common())}")
    return df


def cap_per_class(df: pd.DataFrame, cap: int, seed: int) -> pd.DataFrame:
    out = []
    for (source, harm), group in df.groupby(["source", "harm"]):
        if len(group) > cap:
            group = group.sample(n=cap, random_state=seed)
        out.append(group)
    return pd.concat(out, ignore_index=True)


def build() -> None:
    config.SPLITS_DIR.mkdir(parents=True, exist_ok=True)

    print("== loading sources ==")
    frames = [load_source(s) for s in SOURCES]
    corpus = pd.concat(frames, ignore_index=True)
    print(f"\nraw corpus: {len(corpus):,} rows")

    print("\n== dedupe (before splitting, across all sources) ==")
    corpus["_key"] = corpus["text"].map(norm_key)
    before = len(corpus)
    corpus = corpus.drop_duplicates(subset="_key", keep="first").drop(columns="_key")
    print(f"  removed {before - len(corpus):,} duplicates -> {len(corpus):,} rows")

    print(f"\n== cap at {PER_CLASS_CAP:,} per (source, class) ==")
    corpus = cap_per_class(corpus, PER_CLASS_CAP, config.SEED)
    corpus = corpus.sample(frac=1.0, random_state=config.SEED).reset_index(drop=True)
    print(f"  corpus: {len(corpus):,} rows")

    counts = Counter(corpus["harm"])
    print("\n== class distribution ==")
    for harm in HARM_ORDER:
        n = counts.get(harm.value, 0)
        pct = 100 * n / len(corpus)
        print(f"  {harm.value:<16} {n:>7,}  {pct:5.1f}%")

    scarce = [h.value for h in HARM_ORDER if counts.get(h.value, 0) < 1000]
    if scarce:
        print(f"\n  NOTE: low support for {scarce}. Class weighting is on; report")
        print("  per-class F1 alongside the macro average, never the macro alone.")

    print("\n== splits (stratified on harm, seed "
          f"{config.SEED}) ==")
    train_val, test = train_test_split(
        corpus,
        test_size=config.TEST_FRACTION,
        random_state=config.SEED,
        stratify=corpus["harm"],
    )
    val_rel = config.VAL_FRACTION / (1.0 - config.TEST_FRACTION)
    train, val = train_test_split(
        train_val,
        test_size=val_rel,
        random_state=config.SEED,
        stratify=train_val["harm"],
    )

    for name, part in [("train", train), ("val", val), ("test", test)]:
        path = config.SPLITS_DIR / f"turns_{name}.parquet"
        part.reset_index(drop=True).to_parquet(path, index=False)
        pct = 100 * len(part) / len(corpus)
        print(f"  {name:<6} {len(part):>7,}  {pct:4.1f}%  -> {path.relative_to(config.REPO_ROOT)}")

    print("\n== per-class support by split ==")
    header = f"  {'class':<16}" + "".join(f"{n:>9}" for n in ("train", "val", "test"))
    print(header)
    for harm in HARM_ORDER:
        cells = "".join(
            f"{int((part['harm'] == harm.value).sum()):>9,}"
            for part in (train, val, test)
        )
        print(f"  {harm.value:<16}{cells}")

    print("\ndone.")


if __name__ == "__main__":
    sys.exit(build())
