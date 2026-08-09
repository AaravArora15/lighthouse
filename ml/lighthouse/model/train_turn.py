"""Fine-tune the DistilBERT turn classifier.

    python -m lighthouse.model.train_turn
    python -m lighthouse.model.train_turn --smoke     # 200 steps, sanity only

This is the model that produces per-turn harm scores. The conversation head on day 4
consumes its probabilities; it never consumes its argmax. That is why this script saves
**raw logits** for val and test alongside the checkpoint: temperature scaling on day 2
and the conversation features on day 4 both need the pre-softmax numbers, and re-running
inference to get them back is 10 minutes we do not have to spend twice.

Written as an explicit loop rather than ``Trainer`` for two reasons: class-weighted loss
is a one-line change here and a subclass there, and an explicit loop cannot silently
change behaviour when the library majors.

What to look at in the output, in order:

1. **The DISTRESS/SELF_HARM confusion pair.** Day 1's TF-IDF baseline confused these
   736 times in the two directions combined. It is the hardest and most consequential
   boundary in the taxonomy because it turns on intent, not vocabulary. If DistilBERT
   does not beat the baseline here, it has not earned its deployment cost.
2. **The safety view.** Risky turns missed entirely as benign.
3. **Per-class F1**, especially THREAT (70 test examples, moves in jumps).
4. Macro-F1 last. It is the headline, but it is the least informative of the four.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from torch.utils.data import DataLoader, Dataset, Sampler

from lighthouse import config
from lighthouse.eval.metrics import confusion_pair, format_confusion, safety_view
from lighthouse.taxonomy import HARM_ORDER, HARM_TO_ID, Harm

LABELS = [h.value for h in HARM_ORDER]
LABEL_TO_ID = {h.value: HARM_TO_ID[h] for h in HARM_ORDER}


# --------------------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------------------


class TurnDataset(Dataset):
    """Pre-tokenised turns. The corpus is 65k rows of at most 1000 chars, so tokenising
    once up front costs ~20s and saves re-tokenising the train split three times."""

    def __init__(self, texts: list[str], labels: list[int], tokenizer) -> None:
        enc = tokenizer(
            texts,
            truncation=True,
            max_length=config.TURN_MAX_LENGTH,
            padding=False,
        )
        self.input_ids = enc["input_ids"]
        self.attention_mask = enc["attention_mask"]
        self.labels = labels

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, i: int) -> dict:
        return {
            "input_ids": self.input_ids[i],
            "attention_mask": self.attention_mask[i],
            "label": self.labels[i],
        }


def collate(batch: list[dict], pad_id: int) -> dict[str, torch.Tensor]:
    """Dynamic padding to the longest sequence in the batch.

    Matters more than usual here: the median turn is 265 chars and the 75th percentile is
    722, so padding everything to 256 tokens would waste over half the compute on a
    laptop GPU.
    """
    n = max(len(b["input_ids"]) for b in batch)
    ids = torch.full((len(batch), n), pad_id, dtype=torch.long)
    mask = torch.zeros((len(batch), n), dtype=torch.long)
    for i, b in enumerate(batch):
        k = len(b["input_ids"])
        ids[i, :k] = torch.tensor(b["input_ids"], dtype=torch.long)
        mask[i, :k] = torch.tensor(b["attention_mask"], dtype=torch.long)
    return {
        "input_ids": ids,
        "attention_mask": mask,
        "labels": torch.tensor([b["label"] for b in batch], dtype=torch.long),
    }


class LengthGroupedBatchSampler(Sampler[list[int]]):
    """Batch turns of similar length together.

    This is the single change that makes training on this hardware affordable. The M2 is
    a flat ~2.2k tokens/s wall, so step time is a pure function of tokens pushed, and
    padding tokens cost exactly as much as real ones. Turn lengths here are badly skewed
    (median ~66 tokens, 75th percentile ~180, cap 256), so with shuffled batches nearly
    every batch of 32 contains at least one long turn and dynamic padding inflates the
    whole batch to it. Measured on day 2: we were paying for ~2.5x the tokens the data
    actually contains.

    The fix has to shorten batches without making the epoch deterministic, since fixed
    batch composition across epochs is its own kind of overfitting. So: shuffle, cut into
    megabatches of ``batch_size * megabatch``, sort each megabatch by length, cut those
    into batches, then shuffle the batch order. Composition still changes every epoch,
    but a batch's padding is now bounded by the length spread inside one megabatch
    instead of the spread across the whole corpus.

    Yields lists of indices, so it goes to ``DataLoader(batch_sampler=...)``.
    """

    def __init__(
        self,
        lengths: list[int],
        batch_size: int,
        generator: torch.Generator,
        megabatch: int = config.TURN_LENGTH_GROUP_MEGABATCH,
    ) -> None:
        self.lengths = lengths
        self.batch_size = batch_size
        self.generator = generator
        self.megabatch = max(1, megabatch)

    def __len__(self) -> int:
        return math.ceil(len(self.lengths) / self.batch_size)

    def __iter__(self):
        perm = torch.randperm(len(self.lengths), generator=self.generator).tolist()
        span = self.batch_size * self.megabatch

        batches: list[list[int]] = []
        for i in range(0, len(perm), span):
            chunk = sorted(perm[i : i + span], key=lambda j: self.lengths[j], reverse=True)
            batches.extend(
                chunk[k : k + self.batch_size]
                for k in range(0, len(chunk), self.batch_size)
            )

        order = torch.randperm(len(batches), generator=self.generator).tolist()
        for b in order:
            yield batches[b]


def length_sorted_order(ds: "TurnDataset") -> tuple[list[int], np.ndarray]:
    """A deterministic length-sorted read order for eval, plus the permutation that undoes it.

    Inference pays the same padding tax as training, and with five eval passes over
    ~9.7k val + 9.7k test rows it is not a rounding error. But reordering rows is
    dangerous here: ``turn_logits.npz`` is consumed by temperature scaling today and by
    the conversation head on day 4, and both index it positionally against the labels. So
    the sort is applied on the way in and inverted on the way out, in exactly one place
    (``infer_logits``), rather than being left for a caller to remember.
    """
    order = sorted(range(len(ds)), key=lambda i: len(ds.input_ids[i]))
    inverse = np.empty(len(order), dtype=np.int64)
    inverse[np.asarray(order, dtype=np.int64)] = np.arange(len(order), dtype=np.int64)
    return order, inverse


def load_split(name: str) -> pd.DataFrame:
    path = config.SPLITS_DIR / f"turns_{name}.parquet"
    if not path.exists():
        sys.exit(f"missing {path}\nRun: python -m lighthouse.data.build_splits")
    return pd.read_parquet(path)


def class_weights(labels: list[int], n_classes: int) -> torch.Tensor | None:
    """sklearn's "balanced" formula: n / (k * count_c).

    THREAT has 327 training examples against NONE's 17,100, so unweighted training would
    reach a good macro-accuracy by never predicting THREAT at all. The gate covers
    explicit threats regardless, but a classifier that has structurally given up on a
    class is not something to ship quietly.
    """
    if config.CLASS_WEIGHTING != "balanced":
        return None
    counts = np.bincount(labels, minlength=n_classes).astype(np.float64)
    counts[counts == 0] = 1.0
    w = len(labels) / (n_classes * counts)
    return torch.tensor(w, dtype=torch.float32)


# --------------------------------------------------------------------------------------
# Train / eval
# --------------------------------------------------------------------------------------


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


@torch.no_grad()
def infer_logits(
    model, loader: DataLoader, device: torch.device, inverse: np.ndarray | None = None
) -> np.ndarray:
    """Logits in **dataset order**.

    ``inverse`` undoes the length sort applied by ``length_sorted_order``. Getting this
    wrong would not crash; it would silently shuffle logits against labels and show up as
    a mysteriously bad macro-F1, so the unsort lives here and nowhere else.
    """
    model.eval()
    out: list[np.ndarray] = []
    for batch in loader:
        logits = model(
            input_ids=batch["input_ids"].to(device),
            attention_mask=batch["attention_mask"].to(device),
        ).logits
        out.append(logits.float().cpu().numpy())
    logits = np.concatenate(out, axis=0)
    return logits if inverse is None else logits[inverse]


def report(split: str, logits: np.ndarray, y_true: np.ndarray) -> dict:
    y_pred = logits.argmax(axis=1)
    macro = f1_score(y_true, y_pred, average="macro", zero_division=0)
    weighted = f1_score(y_true, y_pred, average="weighted", zero_division=0)

    print(f"\n{'=' * 66}")
    print(f"{split.upper()}  macro-F1 = {macro:.4f}   weighted-F1 = {weighted:.4f}")
    print(
        classification_report(
            y_true,
            y_pred,
            labels=list(range(len(LABELS))),
            target_names=LABELS,
            digits=3,
            zero_division=0,
        )
    )
    cm = confusion_matrix(y_true, y_pred, labels=list(range(len(LABELS))))
    print(format_confusion(cm, LABELS))

    rep = classification_report(
        y_true,
        y_pred,
        labels=list(range(len(LABELS))),
        target_names=LABELS,
        output_dict=True,
        zero_division=0,
    )
    return {
        "macro_f1": float(macro),
        "weighted_f1": float(weighted),
        "per_class_f1": {l: float(rep[l]["f1-score"]) for l in LABELS},
        "support": {l: int(rep[l]["support"]) for l in LABELS},
        "confusion": cm.tolist(),
    }


def print_domain_views(logits: np.ndarray, y_true: np.ndarray) -> dict:
    y_pred = logits.argmax(axis=1)
    risky = {LABEL_TO_ID[Harm.SELF_HARM.value], LABEL_TO_ID[Harm.THREAT.value]}
    sv = safety_view(y_pred, y_true, risky, LABEL_TO_ID[Harm.NONE.value])
    pair = confusion_pair(
        y_pred,
        y_true,
        LABEL_TO_ID[Harm.DISTRESS.value],
        LABEL_TO_ID[Harm.SELF_HARM.value],
    )

    print(f"\n{'=' * 66}")
    print("SAFETY VIEW (self_harm + threat as one 'must not miss' bucket)")
    print(
        f"  recall into the risky bucket : {sv['risky_bucket_recall']:.3f}"
        f"  (n={sv['risky_total']:,})"
    )
    print(f"  missed entirely as 'none'    : {sv['missed_as_none_rate']:.3f}")

    print("\nTHE HARD BOUNDARY (day 1's dominant error mode)")
    print(
        f"  true distress  -> pred self_harm : {pair['a_as_b']:,} / {pair['a_total']:,}"
        f" = {pair['a_as_b'] / max(pair['a_total'], 1):.3f}"
    )
    print(
        f"  true self_harm -> pred distress  : {pair['b_as_a']:,} / {pair['b_total']:,}"
        f" = {pair['b_as_a'] / max(pair['b_total'], 1):.3f}"
    )
    print(f"  combined                         : {pair['a_as_b'] + pair['b_as_a']:,}")
    return {"safety_view": sv, "distress_self_harm": pair}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="200 steps, no checkpoint save")
    ap.add_argument("--epochs", type=int, default=config.TURN_EPOCHS)
    ap.add_argument(
        "--max-steps",
        type=int,
        default=0,
        help="stop after N steps and report throughput only. For timing a real epoch on "
        "the full split, which --smoke cannot do because it subsamples.",
    )
    args = ap.parse_args()

    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        get_linear_schedule_with_warmup,
    )

    torch.manual_seed(config.SEED)
    np.random.seed(config.SEED)

    device = pick_device()
    print(f"device: {device}  |  model: {config.TURN_MODEL_NAME}")

    train_df, val_df, test_df = (load_split(n) for n in ("train", "val", "test"))
    if args.smoke:
        train_df = train_df.sample(n=4_000, random_state=config.SEED)
        val_df = val_df.sample(n=1_000, random_state=config.SEED)
        test_df = test_df.sample(n=1_000, random_state=config.SEED)
    print(f"train {len(train_df):,} | val {len(val_df):,} | test {len(test_df):,}")

    tok = AutoTokenizer.from_pretrained(config.TURN_MODEL_NAME)
    print("tokenising ...", flush=True)
    t0 = time.time()
    sets = {
        name: TurnDataset(
            df["text"].tolist(), [LABEL_TO_ID[h] for h in df["harm"]], tok
        )
        for name, df in (("train", train_df), ("val", val_df), ("test", test_df))
    }
    print(f"  {time.time() - t0:.1f}s")

    pad_id = tok.pad_token_id
    collate_fn = lambda b: collate(b, pad_id)  # noqa: E731

    train_lengths = [len(x) for x in sets["train"].input_ids]
    loaders = {
        "train": DataLoader(
            sets["train"],
            batch_sampler=LengthGroupedBatchSampler(
                train_lengths,
                config.TURN_BATCH_SIZE,
                torch.Generator().manual_seed(config.SEED),
            ),
            collate_fn=collate_fn,
        )
    }
    inverses: dict[str, np.ndarray] = {}
    for name in ("val", "test"):
        order, inverse = length_sorted_order(sets[name])
        inverses[name] = inverse
        loaders[name] = DataLoader(
            sets[name],
            batch_size=config.TURN_BATCH_SIZE,
            sampler=order,
            collate_fn=collate_fn,
        )

    packed = sum(train_lengths)
    naive = len(train_lengths) * config.TURN_MAX_LENGTH
    print(
        f"length grouping: megabatch={config.TURN_LENGTH_GROUP_MEGABATCH}"
        f"  real tokens {packed / 1e6:.1f}M"
        f"  vs {naive / 1e6:.1f}M if padded to {config.TURN_MAX_LENGTH}"
    )

    model = AutoModelForSequenceClassification.from_pretrained(
        config.TURN_MODEL_NAME,
        num_labels=len(LABELS),
        id2label={i: l for i, l in enumerate(LABELS)},
        label2id=LABEL_TO_ID,
    ).to(device)

    weights = class_weights(sets["train"].labels, len(LABELS))
    if weights is not None:
        print("class weights: " + ", ".join(f"{l}={w:.2f}" for l, w in zip(LABELS, weights)))
        weights = weights.to(device)

    steps_per_epoch = len(loaders["train"])
    total_steps = steps_per_epoch * args.epochs
    if args.smoke:
        total_steps = min(total_steps, 200)
    # --max-steps caps the run but must NOT shorten the LR schedule: the point of a timing
    # run is to measure the real thing, and a compressed schedule is not the real thing.
    stop_at = args.max_steps if args.max_steps > 0 else total_steps
    optim = torch.optim.AdamW(
        model.parameters(),
        lr=config.TURN_LEARNING_RATE,
        weight_decay=config.TURN_WEIGHT_DECAY,
    )
    sched = get_linear_schedule_with_warmup(
        optim,
        num_warmup_steps=int(config.TURN_WARMUP_RATIO * total_steps),
        num_training_steps=total_steps,
    )

    y_val = np.array(sets["val"].labels)
    y_test = np.array(sets["test"].labels)

    best_macro = -1.0
    best_state: dict | None = None
    best_epoch = -1
    history: list[dict] = []
    step = 0
    t_start = time.time()
    tok_real = 0     # tokens the data actually contains
    tok_pushed = 0   # tokens the GPU was asked to process, padding included

    for epoch in range(1, args.epochs + 1):
        model.train()
        running = 0.0
        seen = 0
        t_epoch = time.time()
        for batch in loaders["train"]:
            tok_real += int(batch["attention_mask"].sum())
            tok_pushed += int(batch["input_ids"].numel())
            logits = model(
                input_ids=batch["input_ids"].to(device),
                attention_mask=batch["attention_mask"].to(device),
            ).logits
            loss = F.cross_entropy(logits, batch["labels"].to(device), weight=weights)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optim.step()
            sched.step()
            optim.zero_grad(set_to_none=True)

            running += loss.item() * len(batch["labels"])
            seen += len(batch["labels"])
            step += 1
            if step % 100 == 0:
                elapsed = time.time() - t_start
                rate = step / elapsed
                eta = (stop_at - step) / max(rate, 1e-6)
                print(
                    f"  epoch {epoch} step {step}/{stop_at}"
                    f"  loss {running / seen:.4f}"
                    f"  {rate:.2f} it/s"
                    f"  {tok_pushed / elapsed / 1000:.1f}k tok/s"
                    f"  pad-eff {tok_real / max(tok_pushed, 1):.2f}"
                    f"  eta {eta / 60:.1f}m",
                    flush=True,
                )
            if step >= stop_at:
                break

        if args.max_steps > 0:
            elapsed = time.time() - t_start
            print(
                f"\n[timing] {step} steps in {elapsed:.0f}s"
                f"  |  {elapsed / step:.3f}s/step"
                f"  |  {tok_pushed / elapsed / 1000:.1f}k tok/s"
                f"  |  padding efficiency {tok_real / max(tok_pushed, 1):.3f}"
            )
            print(
                f"[timing] projected: {steps_per_epoch * elapsed / step / 60:.1f} min/epoch"
                f"  |  {total_steps * elapsed / step / 60:.1f} min for {args.epochs} epochs"
                "  (training only, excludes eval)"
            )
            return

        val_logits = infer_logits(model, loaders["val"], device, inverses["val"])
        macro = f1_score(y_val, val_logits.argmax(axis=1), average="macro", zero_division=0)
        print(
            f"\nepoch {epoch}  train-loss {running / max(seen, 1):.4f}"
            f"  val macro-F1 {macro:.4f}  ({time.time() - t_epoch:.0f}s)"
        )
        history.append({"epoch": epoch, "train_loss": running / max(seen, 1), "val_macro_f1": float(macro)})

        # Keep the best epoch, not the last. Three epochs on 45k rows overfits the tail
        # classes reliably; the val macro-F1 usually peaks at 2.
        if macro > best_macro:
            best_macro = float(macro)
            best_epoch = epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

        if step >= stop_at:
            break

    if best_state is not None:
        model.load_state_dict(best_state)
        model.to(device)
    print(f"\nrestored best epoch: {best_epoch} (val macro-F1 {best_macro:.4f})")

    val_logits = infer_logits(model, loaders["val"], device, inverses["val"])
    test_logits = infer_logits(model, loaders["test"], device, inverses["test"])

    results: dict = {
        "model": config.TURN_MODEL_NAME,
        "epochs_run": args.epochs,
        "best_epoch": best_epoch,
        "smoke": args.smoke,
        "train_seconds": round(time.time() - t_start, 1),
        "padding_efficiency": round(tok_real / max(tok_pushed, 1), 4),
        "history": history,
        "val": report("val", val_logits, y_val),
        "test": report("test", test_logits, y_test),
    }
    results["test"].update(print_domain_views(test_logits, y_test))

    baseline_path = config.ARTIFACTS_DIR / "baseline_tfidf.json"
    if baseline_path.exists():
        base = json.loads(baseline_path.read_text())
        delta = results["test"]["macro_f1"] - base["test"]["macro_f1"]
        print(f"\n{'=' * 66}")
        print(f"TF-IDF baseline test macro-F1 : {base['test']['macro_f1']:.4f}")
        print(f"DistilBERT   test macro-F1    : {results['test']['macro_f1']:.4f}")
        print(f"delta                          : {delta:+.4f}")
        results["baseline_delta_macro_f1"] = float(delta)

    if args.smoke:
        print("\n[smoke] nothing written.")
        return

    config.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    config.TURN_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(config.TURN_MODEL_DIR)
    tok.save_pretrained(config.TURN_MODEL_DIR)

    # Raw logits, so calibration (today) and the conversation head (day 4) never have to
    # re-run inference.
    np.savez_compressed(
        config.ARTIFACTS_DIR / "turn_logits.npz",
        val_logits=val_logits,
        val_labels=y_val,
        test_logits=test_logits,
        test_labels=y_test,
        label_order=np.array(LABELS),
    )
    (config.ARTIFACTS_DIR / "turn_distilbert.json").write_text(json.dumps(results, indent=2))

    print(f"\nwrote {config.TURN_MODEL_DIR.relative_to(config.REPO_ROOT)}/")
    print(f"wrote {(config.ARTIFACTS_DIR / 'turn_logits.npz').relative_to(config.REPO_ROOT)}")
    print(f"wrote {(config.ARTIFACTS_DIR / 'turn_distilbert.json').relative_to(config.REPO_ROOT)}")
    print(f"\nHEADLINE: DistilBERT test macro-F1 = {results['test']['macro_f1']:.4f}")


if __name__ == "__main__":
    sys.exit(main())
