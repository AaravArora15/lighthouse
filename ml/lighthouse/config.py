"""Single-file tunables for the Lighthouse ML runtime.

Every magic number lives here. If you find a threshold inline in another module, move it
here. Pattern borrowed from ``a prior project``.

The TypeScript runtime has its own mirror at ``web/src/lib/config.ts``. Values that must
agree across both are marked MIRRORED.
"""

from __future__ import annotations

import os
from pathlib import Path

# --------------------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------------------

ML_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_DIR.parent

DATA_DIR = Path(os.environ.get("LIGHTHOUSE_DATA_DIR", REPO_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
SPLITS_DIR = DATA_DIR / "splits"
ARTIFACTS_DIR = DATA_DIR / "artifacts"

# --------------------------------------------------------------------------------------
# Reproducibility
# --------------------------------------------------------------------------------------

SEED = 20260804
"""Fixed everywhere. Splits, model init, sampling. Never randomise per run."""

# --------------------------------------------------------------------------------------
# Splits
# --------------------------------------------------------------------------------------

TEST_FRACTION = 0.15
VAL_FRACTION = 0.15
"""Val is carved from the post-test remainder, so effective sizes are 70/15/15."""

MIN_TURN_CHARS = 3
"""Turns shorter than this after cleaning are dropped as noise."""

MAX_TURN_CHARS = 1000
"""Turns longer than this are truncated. Well above the DistilBERT 512-token window."""

# --------------------------------------------------------------------------------------
# Turn-level model
# --------------------------------------------------------------------------------------

TURN_MODEL_NAME = "distilbert-base-uncased"
TURN_MAX_LENGTH = 256
TURN_BATCH_SIZE = 32
TURN_LEARNING_RATE = 3e-5
TURN_EPOCHS = 3
TURN_WARMUP_RATIO = 0.1
TURN_WEIGHT_DECAY = 0.01

CLASS_WEIGHTING = "balanced"
"""The harm classes are heavily imbalanced; SELF_HARM is the rarest and the costliest
to miss. Options: "balanced" | None."""

# --------------------------------------------------------------------------------------
# Conversation head
# --------------------------------------------------------------------------------------

TOP_K_TURNS = 3
"""Number of highest-scoring turns averaged into the top-k mean feature."""

CONCERN_THRESHOLD = 0.5
"""tau: a turn counts as "concerning" for the count>tau feature above this harm prob."""

TREND_MIN_TURNS = 4
"""Below this many turns, the trend-slope feature is reported as 0.0 rather than fit."""

# --------------------------------------------------------------------------------------
# Triage economics
# --------------------------------------------------------------------------------------

COUNSELLOR_WEEKLY_BUDGET = 20
"""Cases a single counsellor can meaningfully work per week. The denominator for
recall@budget, which is the metric that actually matters to a school."""

TARGET_RECALL_AT_BUDGET = 0.90
"""Day 4 pass bar: combined T3+T4 recall at the budget above."""

# --------------------------------------------------------------------------------------
# Safety gate
# --------------------------------------------------------------------------------------

GATE_HIGH_SCORE = 0.70
"""At or above this weighted score the gate is "high": crisis resources render
unconditionally, before any model output. MIRRORED."""

GATE_GREY_SCORE = 0.35
"""Between grey and high the gate is uncertain: it does not floor, but it marks the case
as grey_risk, which is an escalation signal for the conversation head. MIRRORED."""

# --------------------------------------------------------------------------------------
# Escalation card
# --------------------------------------------------------------------------------------

MAX_CITED_QUOTES = 3
"""Hard cap. A card with more than three quotes stops being scannable. MIRRORED."""

MIN_QUOTE_CHARS = 15
"""Quotes shorter than this carry no evidentiary value and are padded from the next
highest-scoring turn."""

# --------------------------------------------------------------------------------------
# Retention
# --------------------------------------------------------------------------------------

RETENTION_DAYS_NON_ESCALATED = 30
"""Non-escalated conversations auto-delete after this many days. The student is told this
number up front, so it must match the consent copy. MIRRORED."""

# --------------------------------------------------------------------------------------
# Classifier service
# --------------------------------------------------------------------------------------

CLASSIFIER_TIMEOUT_SECONDS = 4.0
"""Past this, live chat degrades to gate-only triage and says so in the UI. MIRRORED."""
