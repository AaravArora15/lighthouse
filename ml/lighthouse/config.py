"""Single-file tunables for the Lighthouse ML runtime.

Every magic number lives here. If you find a threshold inline in another module, move it
here.

The TypeScript runtime has its own mirror at ``web/src/lib/config.ts``. Values that must
agree across both are marked MIRRORED.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# --------------------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------------------

ML_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_DIR.parent

# Load ``ml/.env`` on import, so a credential works from any entry point without every
# script remembering to call this. ``override=False`` means a variable already exported in
# the shell wins over the file — CI and Colab set real environment variables and must not
# be silently overridden by a stale local file.
#
# The day 2 log promised credentials "go in ml/.env, which is already gitignored". That was
# only half true until day 5: the file was ignored, but nothing ever read it, so a key
# dropped there would have looked correct and done nothing.
load_dotenv(ML_DIR / ".env", override=False)

DATA_DIR = Path(os.environ.get("LIGHTHOUSE_DATA_DIR", REPO_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
SPLITS_DIR = DATA_DIR / "splits"
ARTIFACTS_DIR = DATA_DIR / "artifacts"

FIXTURES_DIR = REPO_ROOT / "fixtures"
"""Committed, hand-authored test data. Deliberately NOT under ``data/``, which is
gitignored wholesale: the synthetic conversations are the day 5-9 demo seed and the day 3
gate evidence, so they have to be in the repo. Nothing real ever goes here."""

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

TURN_LENGTH_GROUP_MEGABATCH = 50
"""Length-grouped batching: batches are cut from shuffled chunks of this many batches.

The training hardware is a flat ~2.2k tokens/s wall (context.md §9), so step time is a
pure function of tokens pushed, padding included. Larger values pad less but make the
epoch less random; 50 is the transformers default and lands padding efficiency near 0.9
without measurably hurting the loss curve. Set to 1 to disable grouping entirely."""

TURN_MODEL_DIR = ARTIFACTS_DIR / "turn_model"
"""Where the fine-tuned turn classifier is written. Gitignored; pushed to the Hub for
the day 9 HF Space to load."""

TURN_HUB_REPO = os.environ.get("LIGHTHOUSE_HUB_REPO", "lighthouse-turn-classifier")
"""Model repo name on the Hub. Prefixed with the authenticated user at push time."""

# --------------------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------------------

CALIBRATION_BINS = 15
"""Equal-width confidence bins for the reliability diagram and ECE. 15 keeps roughly
600 test turns per bin, which is enough that a bin's empirical accuracy is not noise."""

TEMPERATURE_MAX_ITER = 200
"""LBFGS iterations for the single-parameter temperature fit. Converges in far fewer."""

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

SCHOOL_WEEKLY_CONVERSATIONS = 100
"""Assumed intake volume for one secondary school in one week.

**This is an assumption, not a measurement**, and recall@budget is meaningless without it:
the metric is "of the cases that needed a counsellor, how many made the top 20", which
depends entirely on how many cases there were. Stated here so it appears in exactly one
place and can be argued with. 100 intakes against a 20-case budget means the counsellor
sees the top fifth of the queue."""

WEEKLY_TIER_PRIOR = {"T0": 0.45, "T1": 0.30, "T2": 0.15, "T3": 0.08, "T4": 0.02}
"""Assumed tier mix of a real school week. Also an assumption, and the load-bearing one.

The synthetic corpus is 45% T3+T4 because it was built to test escalation logic, not to
mirror a school. Computing recall@20 directly on it would be nonsense: 36 escalations
cannot fit in 20 slots, so the metric would top out at 0.56 no matter how good the model
is. The evaluation therefore resamples the corpus into simulated weeks that follow this
prior. Change these numbers and the headline recall changes, which is precisely why they
live in config and are printed in `docs/results.md`."""

RECALL_SIMULATION_WEEKS = 500
"""Simulated weeks averaged for recall@budget. Enough that the standard error on the mean
is small relative to the differences between ablation rungs."""

# --------------------------------------------------------------------------------------
# Conversation head
# --------------------------------------------------------------------------------------

CONVERSATION_HEAD_C = 0.5
"""Inverse L2 strength for the tier head. Deliberately strong.

80 conversations against ~30 features is a regime where an unregularised model memorises
the corpus and reports a macro-F1 that means nothing. If this ever needs raising, get more
conversations first."""

ESCALATION_RANKER_C = 1.0
"""Inverse L2 for the binary "needs a counsellor" ranker that orders the queue.

Looser than the tier head's, because it is fitting one boundary rather than four and has
the same 80 rows to do it with."""

CONVERSATION_CV_REPEATS = 10
"""Times the whole cross-validation is repeated with a different fold assignment.

With 80 rows, which conversations land together is the dominant source of variance. One
seed produces a number; ten produce a number and an honest error bar, and the error bar is
routinely wider than the gap between ablation rungs."""

CONVERSATION_CV_FOLDS = 5
"""Outer folds for the tier head. Every metric in `docs/results.md` is out-of-fold.

With 80 conversations there is no honest train/test split: a 20% test set is 16 rows and
three T4s, and the number would move by 0.05 depending on which three. Cross-validation
over the whole corpus is noisy too, but it is noisy in a way that is reported rather than
hidden behind one lucky split."""

CALIBRATION_INNER_FOLDS = 4
"""Inner folds used to fit the isotonic calibrator inside each training fold.

Nested, because fitting isotonic on the same out-of-fold predictions it is then scored on
would report a calibration error that does not exist."""

# --------------------------------------------------------------------------------------
# Safety gate
# --------------------------------------------------------------------------------------

GATE_HIGH_SCORE = 0.70
"""At or above this weighted score the gate is "high": crisis resources render
unconditionally, before any model output. MIRRORED."""

GATE_GREY_SCORE = 0.35
"""Between grey and high the gate is uncertain: it does not floor, but it marks the case
as grey_risk, which is an escalation signal for the conversation head. MIRRORED."""

GATE_SEVERITY_WEIGHTS = {"strong": 1.0, "moderate": 0.6, "weak": 0.3}
"""Per-match weights for the three graded pattern families. MIRRORED.

Chosen so the score bands mean something rather than being arbitrary decimals, given the
noisy-OR aggregation in ``gate.safety``:

* one STRONG match          -> 1.00, high
* two MODERATE matches      -> 0.84, high      (two independent concerning readings)
* one MODERATE match        -> 0.60, grey
* two WEAK matches          -> 0.51, grey
* one WEAK match            -> 0.30, clear     (a topic word with no stance)
"""

GATE_FLOOR_MIN_WEIGHT = 0.6
"""A category only contributes a tier floor if it matched at this weight or above.

This is the line that stops the gate from de-anonymising a child over the word "knife".
WEAK matches still raise the score and can push a case into the grey band, which routes it
to the conversation head; they just cannot force a tier on their own. MIRRORED."""

GATE_CEILING_WITHOUT_T4_EVIDENCE = "T3"
"""The highest tier the gate permits when no T4-capable category fired. MIRRORED.

The floor rule protects against under-reacting. This protects against over-reacting, which
is not a symmetric concern but is a real one: T4 means break-glass, and break-glass means
lifting a student's anonymity. Doing that on a conversation with no self-harm, no abuse
disclosure and no imminent danger evidence is a harm in itself, and it is the failure mode
that would get the tool switched off by a school.

Deliberately overridable by one thing only: strong calibrated self-harm evidence from the
classifier (``gate.safety.apply_verdict(..., t4_override=True)``), so a phrasing the regex
banks never anticipated cannot be capped into invisibility. Every override is recorded."""

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
# Cross-conversation pattern detection
# --------------------------------------------------------------------------------------

PATTERN_WINDOW_DAYS = 14
"""Two reports only link if they arrive within this many days.

A report from last term and one from today are a history, not a pattern. Without a window
the clusters grow monotonically and a counsellor is shown the same stale alert forever.
Fourteen days is about one school fortnight, which is the unit staff actually think in."""

PATTERN_MIN_CLUSTER = 3
"""Cases needed before an alert is raised.

Two linked reports is a coincidence a counsellor would likely spot unaided; three is the
point where a pattern exists and nobody is positioned to see it. Lower and the console
fills with pairs, which trains people to ignore the panel."""

PATTERN_ENTITY_THRESHOLD = 0.34
"""Jaccard overlap of entity pseudonyms needed to link WITHOUT an exactly-shared entity.
Roughly "one shared entity out of three"."""

PATTERN_LEXICAL_THRESHOLD = 0.55
"""Blended BM25 + char-trigram similarity required to corroborate an entity link.

Never sufficient alone. Every conversation in this corpus is a teenager describing school
in the same register, so a purely lexical linker merges the entire corpus into one
meaningless cluster. Text similarity corroborates; entities link."""

# --------------------------------------------------------------------------------------
# LLM
# --------------------------------------------------------------------------------------

INTAKE_MODEL = "claude-opus-5"
"""The only model this project calls, for both intake replies and entity extraction.
MIRRORED with ``web/src/lib/config.ts``.

Note what it is never used for: it does not see a tier, propose one, or influence one.
That separation is the project thesis (CLAUDE.md) and it is why this constant lives beside
the tunables rather than inside the model layer."""

# --------------------------------------------------------------------------------------
# Classifier service
# --------------------------------------------------------------------------------------

CLASSIFIER_TIMEOUT_SECONDS = 4.0
"""Past this, live chat degrades to gate-only triage and says so in the UI. MIRRORED."""
