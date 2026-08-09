"""Score every student turn in the synthetic corpus with the fine-tuned classifier.

    python -m lighthouse.model.score_turns

Runs once and writes ``fixtures/synthetic_turn_probs.json``: 245 turns x 6 calibrated
probabilities, about 40KB.

**The cache is committed on purpose.** Three reasons, and the third is the important one:

1. The conversation head, the ablation, and every day 4 test then run with no torch, no
   transformers, no 268MB checkpoint and no GPU. `pytest` stays under a second.
2. `data/artifacts/turn_model/` is gitignored, so anything reading it directly cannot be
   reproduced from a fresh clone. This file can.
3. It is the same trick day 9 uses to put a demo on a free HF Space: precomputed scores,
   so the live path never waits on inference it does not need. Building it now means the
   deploy is exercising a code path that has already been tested for five days.

Probabilities are **temperature-scaled** with the T fitted in ``calibrate_turn`` (1.342 on
the day 2 run), because the conversation head consumes them as probabilities and not as
scores. Feeding it the raw overconfident softmax would bake the miscalibration into every
downstream feature, and no amount of isotonic regression at the tier level would undo it.

Re-run this after any retrain. The cache records the temperature and the label order it was
built with, and the loader refuses to serve a cache whose label order no longer matches the
taxonomy.
"""

from __future__ import annotations

import json
import sys

import numpy as np

from lighthouse import config
from lighthouse.data.synthetic import load
from lighthouse.taxonomy import HARM_ORDER

CACHE = config.FIXTURES_DIR / "synthetic_turn_probs.json"


def _temperature() -> float:
    """The T fitted on val in ``calibrate_turn``. Falls back to 1.0 with a loud warning."""
    path = config.ARTIFACTS_DIR / "turn_calibration.json"
    if not path.exists():
        print(
            f"WARNING: {path.name} missing, using T=1.0 (uncalibrated).\n"
            "         Run: python -m lighthouse.model.calibrate_turn",
            file=sys.stderr,
        )
        return 1.0
    return float(json.loads(path.read_text())["temperature"])


def main() -> None:
    # Imported here, not at module scope, so that merely importing this module during a
    # test collection does not drag torch into the process.
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    if not config.TURN_MODEL_DIR.exists():
        sys.exit(
            f"missing {config.TURN_MODEL_DIR}\n"
            "Unzip the Colab checkpoint: "
            "unzip -o ~/Downloads/lighthouse_turn_model.zip -d data/artifacts/"
        )

    conversations = load()
    turns: list[str] = []
    index: list[tuple[str, int]] = []
    for convo in conversations:
        for i, text in enumerate(convo.student_turns):
            turns.append(text)
            index.append((convo.id, i))

    temperature = _temperature()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"{len(turns)} student turns from {len(conversations)} conversations")
    print(f"device: {device}  |  temperature: {temperature:.4f}")

    tokenizer = AutoTokenizer.from_pretrained(config.TURN_MODEL_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(config.TURN_MODEL_DIR)
    model.to(device).eval()

    probs: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, len(turns), config.TURN_BATCH_SIZE):
            batch = turns[start : start + config.TURN_BATCH_SIZE]
            enc = tokenizer(
                batch,
                truncation=True,
                max_length=config.TURN_MAX_LENGTH,
                padding=True,
                return_tensors="pt",
            ).to(device)
            logits = model(**enc).logits.float().cpu().numpy()
            probs.append(_softmax(logits / temperature))
    matrix = np.concatenate(probs, axis=0)

    by_conversation: dict[str, list[list[float]]] = {c.id: [] for c in conversations}
    for (convo_id, _), row in zip(index, matrix):
        by_conversation[convo_id].append([round(float(p), 6) for p in row])

    CACHE.write_text(
        json.dumps(
            {
                "model": str(config.TURN_MODEL_DIR.name),
                "temperature": round(temperature, 6),
                "label_order": [h.value for h in HARM_ORDER],
                "probs": by_conversation,
            },
            indent=1,
        )
    )
    print(f"wrote {CACHE.relative_to(config.REPO_ROOT)} "
          f"({CACHE.stat().st_size / 1024:.0f} KB)")

    _report(conversations, by_conversation)


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def _report(conversations, by_conversation) -> None:
    """A sanity read before anything downstream trusts these numbers.

    Mean risk should climb monotonically with tier. If it does not, the classifier is not
    seeing what the hand-labelling saw, and the conversation head is about to paper over
    that rather than fix it.
    """
    labels = [h.value for h in HARM_ORDER]
    print("\nmean max-risk (1 - P(none)) by hand-assigned tier:")
    by_tier: dict[str, list[float]] = {}
    for convo in conversations:
        rows = np.array(by_conversation[convo.id])
        by_tier.setdefault(convo.tier.value, []).append(float((1 - rows[:, 0]).max()))
    for tier in sorted(by_tier):
        values = by_tier[tier]
        print(f"  {tier}  n={len(values):2}  mean {np.mean(values):.3f}  "
              f"min {np.min(values):.3f}")

    print("\nmost likely harm label per tier (over all turns):")
    for tier in sorted(by_tier):
        rows = np.concatenate(
            [by_conversation[c.id] for c in conversations if c.tier.value == tier]
        )
        counts = np.bincount(rows.argmax(axis=1), minlength=len(labels))
        top = " ".join(
            f"{labels[i]}={counts[i]}" for i in np.argsort(-counts) if counts[i]
        )
        print(f"  {tier}  {top}")


if __name__ == "__main__":
    main()
