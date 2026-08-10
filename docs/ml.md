# The ML in Lighthouse, and why each piece is there

This is the *why* document. `docs/results.md` has the numbers and the error analysis;
`docs/context.md` has the locked decisions. This one explains the techniques themselves,
in the order data flows through them, and says what each was chosen **for** rather than
what it is in the abstract.

Written for a reader who knows what a training set is and has trained something before,
but has not necessarily met calibration or nested isotonic regression.

**All conversation data in this project is synthetic and hand-authored.** No student wrote
any of it.

---

## Contents

1. [The turn classifier](#1-the-turn-classifier)
2. [Making the confidence numbers trustworthy](#2-making-the-confidence-numbers-trustworthy)
3. [From single messages to whole conversations](#3-from-single-messages-to-whole-conversations)
4. [Measuring honestly](#4-measuring-honestly)
5. [The cross-conversation layer](#5-the-cross-conversation-layer)
6. [Not ML, doing ML-adjacent jobs](#6-not-ml-doing-ml-adjacent-jobs)
7. [The thread running through all of it](#7-the-thread-running-through-all-of-it)

---

## 1. The turn classifier

### Transfer learning / fine-tuning

**What:** DistilBERT arrives already trained on a large amount of general English. We
continue training it on our labelled data, so it starts out knowing the language and only
has to learn our task.

**Why here:** we had about 45,000 labelled training rows. Nowhere near enough to train a
language model from scratch, which needs billions of tokens. Plenty to *adapt* one.
Training from scratch would have produced noise; fine-tuning reached **0.7670 test
macro-F1 in 23 minutes 24 seconds** on a free Colab T4.

**Why DistilBERT and not something larger:** it is a distilled BERT, roughly 40% smaller
and 60% faster for about 97% of the performance. This model has to run per message on
free-tier hosting. A larger model buys a point or two of F1 and costs the ability to deploy
it at all.

### What it outputs

Six harm categories with a probability each, per message. That per-message probability
vector is the raw material every downstream component is built from, and it is cached at
`fixtures/synthetic_turn_probs.json` so the conversation head, the ablation and every day 4
test run with no torch, no checkpoint and no GPU.

### Logits and softmax

The model's raw outputs are **logits**, unbounded real numbers. **Softmax** converts them
to probabilities summing to 1. Worth naming because calibration below operates on the
logits *before* softmax, not on the probabilities after.

### Length-grouped batching

**What:** a GPU processes a batch as a rectangle, so every sequence is padded to the
longest in the batch. Batch a 10-word message with a 250-word one and you compute 240 words
of padding for nothing. Sorting by length first, so similar lengths batch together, removes
most of that waste.

**Why it mattered:** padding efficiency went from **0.363 to 0.976**, which is 2.5x fewer
tokens pushed for identical results. That turned a 2.3-hour local run into something
feasible.

Not a modelling idea, an engineering one, and it was the difference between training the
model and not having time to.

---

## 2. Making the confidence numbers trustworthy

The part most projects skip, and the part that matters most for a safeguarding tool.

### The problem: neural networks are overconfident

A fine-tuned classifier will say "97% sure" about things it gets right perhaps 80% of the
time. The *ranking* is fine. The numbers are not.

Fatal here, because a counsellor is shown a confidence figure and asked to trust it, and
the queue ordering depends on those numbers being comparable between cases.

### Temperature scaling

**What:** divide every logit by a single learned scalar T before softmax.

- `T > 1` flattens the distribution, making it less confident
- `T < 1` sharpens it

T is fitted on a **validation set**, never the test set, by minimising negative
log-likelihood.

**Why this method:** it has exactly **one parameter**, so with a small corpus there is
almost nothing to overfit. And because every logit is divided by the same constant, it
**cannot change which class is the argmax**. Calibration therefore cannot change a single
prediction. Honest numbers at zero accuracy risk.

We fitted **T = 1.342**. Greater than 1, meaning the model was overconfident, which is the
expected direction.

### ECE, MCE and Brier score

Three ways to ask "are these numbers honest":

| Metric | What it measures | Before | After |
|---|---|---|---|
| **ECE** | Bin by confidence; average gap between confidence and actual accuracy | 0.0699 | **0.0263** |
| **MCE** | The *worst* bin rather than the average | 0.153 | **0.082** |
| **Brier** | Mean squared error on probabilities; accuracy and calibration together | 0.249 | 0.239 |

ECE fell by 62%. MCE matters separately from ECE because your worst-calibrated bin might be
the high-confidence one, which is exactly where a counsellor trusts you most.

Brier barely moved, and **that is the correct result**. Temperature scaling should fix
calibration without touching accuracy; the small movement is the calibration component of
Brier improving while the accuracy component stays put. A large Brier change would have
meant something unintended happened.

### Reliability diagram

Predicted confidence on the x axis, observed accuracy on the y. Perfect calibration is the
diagonal; below it is overconfidence. Ours sat below the line everywhere before scaling and
hugged it after. Saved at `data/artifacts/reliability_turn.png`.

---

## 3. From single messages to whole conversations

A message classifier is not a triage system. "I'm fine" means something entirely different
as message one than after eight messages of escalating distress.

### Feature engineering

**38 features in 5 groups**, computed from a whole conversation:

- Aggregates over the per-message probabilities: max, mean, count above threshold, fraction above threshold
- Trend: is risk rising across turns
- Gate signals: which categories fired, at what severity
- Conversation shape: length, turn count
- Prior contact: has this student been here before

**Why hand-built features rather than feeding the transcript to a larger model:** there are
85 conversations. A model that learns its own representation from 85 examples memorises
them. Explicit features encode what we already know matters and leave the small model far
less room to overfit.

They are also *inspectable*, which is how the victim-voice finding in
[results.md](results.md) surfaced at all.

### Logistic regression as the head

**Why not a neural network:** 85 training examples. A logistic regression has roughly as
many parameters as it has features. Anything deeper memorises the corpus and tells you
nothing you did not already put in.

There is a product reason too: logistic regression coefficients are directly readable. You
can print which features push a case toward T4 and a human can check whether that is
sensible.

### Isotonic regression, nested

**What:** a non-parametric calibration method. It fits a monotonic, never-decreasing step
function mapping raw scores to calibrated probabilities. Unlike temperature scaling it can
bend into any shape, provided it never goes downhill.

**Why here rather than temperature scaling again:** the conversation head is a different
model with its own miscalibration shape, and there is no single-parameter fix for it.
Monotonicity is the safety property that makes this acceptable: it can never reorder cases,
only rescale their probabilities.

**Why "nested":** the calibrator is fitted *inside* the cross-validation loop, not
afterwards. Fitting it on data the model has already seen makes the calibration numbers
optimistic, and you end up measuring your own leakage.

---

## 4. Measuring honestly

### Grouped splits

**What:** near-duplicate examples are forced into the same split, so a paraphrase of a
training example cannot appear in test.

**Why:** without it the model looks excellent because it has partly memorised. This is the
most common way an ML project lies to itself.

### Macro-F1, not accuracy

**F1** is the harmonic mean of precision and recall. **Macro** averages the per-class F1
equally instead of weighting by class size.

**Why:** the classes are wildly imbalanced. A model that always predicts "no concern" gets
high accuracy and is useless. Macro-F1 makes the rare, important classes count as much as
the common ones.

The proof it matters: the **majority-class baseline scores 0.0914 macro-F1**. Under
accuracy it would have looked respectable.

### Four baselines, not one

| Baseline | Test macro-F1 |
|---|---|
| Majority class (always predict the most common) | 0.0914 |
| Stratified random (guess at class frequencies) | 0.1661 |
| TF-IDF + logistic regression (classical bag-of-words) | 0.7148 |
| **Fine-tuned DistilBERT** | **0.7670** |

**Why all of them:** the trivial two prove the metric is not broken. TF-IDF is the honest
comparison, because if a bag-of-words model lands within a point of your transformer then
the transformer was not worth its complexity. Beating it by **+0.0522** is what justifies
the approach.

**Still missing: a zero-shot Claude baseline.** It would answer whether a frontier model
with no training at all beats a fine-tune on this task, which is the most directly relevant
question an ML challenge could ask. It is an open gap, listed in
[results.md](results.md) §5.

### Ablation

**What:** remove one feature group at a time, retrain, measure the drop. Whatever hurts
most when removed was doing the most work.

**Why:** otherwise you are guessing about which of 38 features earn their place. Ablation
is how you discover you built something that contributes nothing.

### Reading the confusion matrix

Not a technique so much as actually looking at the errors. Ours showed **676 confusions
between distress and self-harm** on test (19% of those two classes combined) and **THREAT
at F1 0.536** on 70 examples.

Reading that carefully is what surfaced **victim voice**: content describing harm done *to*
a student scores systematically lower than the same content phrased as a threat. That is a
finding about the training data, discovered by looking at the model's mistakes rather than
at its score, and it is the reason recall@budget misses its target.

### recall@counsellor-budget

**A custom metric, and operationally the most important one here.** Standard metrics assume
every case is reviewed. A school counsellor reviews roughly 20 a week.

So: sort the queue, take the top 20, and ask what fraction of the genuinely serious cases
(T3 and T4) are inside it. **0.865 ±0.019 against a 0.90 target.** It misses.

**Why invent a metric:** macro-F1 measures the model; this measures the product. Day 4
found that ranking by model score alone understated recall@20 by **0.15** compared with
ranking by gate-floor-then-model. The model was fine. The ranking was scoring a component
rather than the thing the counsellor experiences.

---

## 5. The cross-conversation layer

Detecting that four separate anonymous students are describing the same situation. This is
the capability a school does not currently have.

### BM25

**What:** a ranking function from information retrieval, refining TF-IDF with two
additions: **term frequency saturation** (the tenth mention of a word adds far less than
the second) and **document length normalisation** (long documents do not win by default).

**Why:** it is the standard for "how similar is this text to that text" when you want a
number you can explain. About 40 lines, no dependency, for 85 documents.

### Character n-gram cosine similarity

**What:** cut text into overlapping 3-character chunks, count them, compare two documents
by cosine similarity of those count vectors.

**Why alongside BM25:** character trigrams survive typos, spelling variation and morphology
in a way word matching does not. Teenagers write "stairwell", "stair well" and "stairs",
and word-level matching sees three unrelated tokens.

### Jaccard similarity

Size of the intersection over size of the union. Used for entity overlap: what fraction of
the people and places two conversations name are shared.

### Single-linkage agglomerative clustering

**What:** merge two clusters if *any* member of one is close to *any* member of the other.
Implemented as connected components with union-find.

**Why single linkage specifically:** if A and B share a person, and B and C share a person,
then A and C belong in one cluster even where A and C name nothing in common. That
transitive chain is precisely the pattern a counsellor cannot spot by hand, and stricter
linkage criteria would break it.

### Why embeddings were deliberately avoided

Embeddings would score better on text similarity. They were rejected because **a counsellor
asked to act on a cluster needs "both name the same person and the same corridor", not
"cosine 0.83".**

That is the recurring trade in this project: a measurably worse model that can explain
itself beats a better one that cannot, when a human has to act on the output.

---

## 6. Not ML, doing ML-adjacent jobs

### Noisy-OR aggregation

The safety gate combines multiple pattern matches into one score with `1 - Π(1 - wᵢ)`.

**Why:** it treats each match as independent evidence. Two moderate signals at 0.6 combine
to 0.84, more than either alone but short of certainty. Naive summing would exceed 1.0;
taking the max would throw away the corroboration that two independent readings provide.

### Keyed HMAC pseudonymisation

Not ML, but it is what makes the clustering ethically possible. Names are replaced with
`HMAC-SHA256(key, name)` before clustering. The same name always yields the same token, so
matching works, but the token cannot be reversed. The system can report "three reports name
the same person" while neither it nor the database ever holds who that person is.

---

## 7. The thread running through all of it

Nearly every choice above traded raw performance for one of two things:

**Honesty about uncertainty.** Calibration, three trivial-and-classical baselines, grouped
splits, nested calibration, recall@budget.

**Explainability to a human who has to act.** Hand-built features over learned
representations, logistic regression over a deeper head, BM25 over embeddings, a regex
gate over a model.

That is defensible for this product specifically, because a counsellor deciding whether to
break a child's anonymity has to be able to check the work. It would be the wrong trade for
a recommender system, and it should not be copied without asking whether the same reasoning
applies.

---

## Where to go next

- [results.md](results.md) for the numbers, the ablation table and the honest list of what
  is still wrong
- [context.md](context.md) §5–§8 for the locked taxonomy, gate categories and card schema
- [deploy.md](deploy.md) §3b for running the scoring service locally
