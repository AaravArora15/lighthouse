# Lighthouse — results

Every number here is reproducible from the repo:

```bash
cd ml
python -m lighthouse.baselines.trivial          # label-only floor
python -m lighthouse.baselines.tfidf            # TF-IDF baseline
python -m lighthouse.model.calibrate_turn       # temperature + reliability diagram
python -m lighthouse.data.synthetic             # gate audit over the 80 conversations
python -m lighthouse.model.conversation_head    # the tables below
python -m lighthouse.cluster.patterns           # the cross-conversation alert
pytest -q                                       # 1093 passed, 59 skipped

cd ../web
npm test                                        # 473 passed
```

Only the turn classifier needs the checkpoint. Everything else, including the whole of
day 3, day 4 and the clustering layer, runs offline from committed fixtures with no API key
and no GPU. **1,566 tests in total, none of which need a key, a database or a network.**

---

## 1. Turn classifier (day 2)

45,286 train / 9,705 val / 9,705 test turns. Fine-tuned `distilbert-base-uncased`,
3 epochs, class-weighted cross-entropy, on a free Colab T4 in 23m24s.

| | label-only floor | TF-IDF + LogReg | **DistilBERT** |
|---|---|---|---|
| test macro-F1 | 0.1661 | 0.7148 | **0.7670** |
| test weighted-F1 | — | 0.7981 | **0.8360** |
| risky-bucket recall | 0.179 | 0.722 | **0.807** |
| missed entirely as `none` | — | 0.043 | **0.017** |

Per-class test F1:

| class | support | TF-IDF | DistilBERT |
|---|---|---|---|
| none | 3,665 | 0.871 | **0.908** |
| distress | 1,800 | 0.752 | **0.778** |
| harassment | 1,870 | 0.787 | **0.826** |
| identity_attack | 500 | 0.722 | **0.764** |
| threat | 70 | 0.413 | **0.536** |
| self_harm | 1,800 | 0.744 | **0.789** |

`threat` has 70 test examples, so its F1 moves in jumps and swings the macro average more
than it deserves. Read it next to the others, never alone.

**Accuracy is a vanity metric on this corpus and we do not report it as a headline.** The
majority-class baseline scores 0.378 accuracy while catching **zero** of the 1,870 risky
turns. That is the entire argument for macro-F1 and the safety view.

### Calibration

Temperature fitted on val, applied to test. **T = 1.342.**

| | ECE | MCE | Brier | NLL | mean confidence | accuracy |
|---|---|---|---|---|---|---|
| raw | 0.0699 | 0.153 | 0.249 | 0.460 | 0.904 | 0.834 |
| **temperature-scaled** | **0.0263** | **0.082** | **0.239** | **0.426** | 0.859 | 0.834 |

Accuracy is identical by construction: a single scalar divides every logit, so no argmax
can move. Mean confidence 0.904 against accuracy 0.834 is the overconfidence that
fine-tuning reliably produces, and it is why the counsellor queue would otherwise be sorted
by a number that lies. Diagram: `data/artifacts/reliability_turn.png`.

Caveat worth stating: the model was trained with class-weighted cross-entropy, which
deliberately optimises a reweighted distribution. One temperature improves calibration
without perfecting it. Read the per-class gaps in `turn_calibration.json`, not just ECE.

---

## 2. The finding that shaped day 4: victim voice

The classifier was trained on Jigsaw comments and Reddit posts. **Jigsaw comments *are* the
abuse.** This product receives students *describing* abuse. Measured on our own checkpoint:

| the same harm, two voices | risk (`1 - P(none)`) |
|---|---|
| "nobody wants to talk to you, you freak" | **0.964** |
| "nobody in my class has spoken to me in about two weeks" | **0.021** |
| "you're always last picked because you're useless" | **0.939** |
| "every pe lesson they make sure i'm last picked" | **0.019** |
| "go back to where your family came from" | 0.244 |
| "they keep saying things about where my family are from" | **0.152** |

A **45x gap** on the same underlying harm. The classifier is not broken; it is answering
the question it was trained on ("is this message toxic?") while we ask a different one
("is this student being harmed?").

This is not fixable by aggregation, because there is nothing to aggregate: `1 - P(none)` is
0.02 across the whole transcript. It is a training-data problem, and the honest fix is a
victim-voice corpus we do not have. What day 4 does instead is add deterministic
**harm-report markers** for the four things a safeguarding lead actually reads for:
duration, frequency, avoidance/behaviour change, and disclosure barriers, plus the
protected-characteristic target that defines T3.

---

## 3. Safety gate (day 3)

66 patterns and 21 suppressors across six categories. **123 µs per turn**, 0.36 ms per
conversation, against a 4.0s classifier timeout.

| | |
|---|---|
| synthetic corpus | 80 conversations, 413 turns, 245 student turns |
| **false-positive floors on 26 benign conversations** | **0** |
| **T4 conversations reaching T4 on the gate alone** | **16 / 16** |
| crisis resources shown | exactly the 16 T4 cases |
| conversations receiving any floor | 27 / 80 |
| tests | 456 passed, offline |

Twelve benign conversations are adversarial by construction ("this coursework is killing
me", "we walked 5 kms", "we used a butter knife in food tech", "it's suicide prevention
week", "i stopped cutting last year"). They found three real gate bugs on the day they were
written.

**T2 and most of T3 are gate-silent by design.** There is no gate category for ordinary
harassment or for identity attack, so those 38 conversations are a pure test of the model
half of the system.

---

## 4. Conversation head — the ablation table (day 4)

80 conversations, multinomial logistic regression, **5-fold cross-validation repeated
across 10 seeds**. Every number is out-of-fold, and `±` is the standard deviation across
seeds. On 80 rows the seed spread is routinely larger than the gap between rungs, which is
why it is quoted.

| ablation | features | macro-F1 | Brier | recall@20 |
|---|---|---|---|---|
| gate-only | 13 | 0.469 ±0.023 | 0.540 | 0.692 ±0.012 |
| turn-only | 11 | **0.214** ±0.016 | 0.840 | 0.795 ±0.040 |
| gate+turn | 24 | 0.385 ±0.027 | 0.607 | 0.762 ±0.039 |
| +trend | 29 | 0.558 ±0.041 | 0.609 | 0.711 ±0.019 |
| **+report** | 36 | **0.631** ±0.030 | **0.502** | **0.865** ±0.019 |
| full (+history) | 38 | 0.631 ±0.030 | 0.502 | 0.865 ±0.019 |

Read three things off this table:

1. **`turn-only` scores 0.214 macro-F1.** Barely above chance on five tiers. That is the
   victim-voice finding in one number: the fine-tuned transformer, alone, cannot tier these
   conversations. It is not a bad model, it is the wrong training distribution.
2. **`+report` is the biggest single jump**, +0.073 macro-F1 and **+0.154 recall@20** over
   `+trend`. Deterministic markers beat the transformer on this corpus.
3. **`history` adds exactly nothing**, to four decimal places. The corpus is
   single-session, so the feature is inert. Reported rather than quietly dropped; it is
   plumbed for the day 6 console, which seeds returning students.

### The head is not the product

The head is the learned model. The product is the head **plus the gate floor**, which
`gate.safety.apply_verdict` applies unconditionally afterwards.

| | head alone | **post-gate (what a counsellor sees)** |
|---|---|---|
| macro-F1 | 0.631 | **0.714** |
| **T4 recall** | 0.812 | **1.000** |

The head misses three of sixteen T4 conversations (`syn-066` active self-harm, `syn-070`
threat with a time marker, `syn-079` hopelessness escalating to intent), calling each of
them T3. **The gate catches all three.** Post-gate confusion:

```
          T0    T1    T2    T3    T4
  T0       7     3     1     1     0
  T1       3     9     2     0     0
  T2       3     4    10     1     0
  T3       0     1     3    16     0
  T4       0     0     0     0    16
```

Zero T4 misses, and nothing in the T4 row anywhere but T4. That row is the project thesis
made measurable: **the classifier decides, and the gate makes sure it cannot decide wrong
in the one direction that matters.**

### recall@counsellor-budget

**0.865 ±0.019 against a 0.90 target. A miss.**

The corpus is 45% T3+T4 by construction, so 36 escalations cannot fit in 20 slots and
scoring it directly would cap the metric at 0.56 regardless of model quality. The
evaluation therefore resamples the corpus into 500 simulated school weeks:

| assumption | value |
|---|---|
| intake | 100 conversations/week |
| tier mix | T0 45% · T1 30% · T2 15% · T3 8% · T4 2% |
| counsellor budget | 20 cases/week |

**Both assumptions are guesses**, they live in `ml/lighthouse/config.py`, and the headline
moves if you change them. Argue with them.

The queue is ranked by `floor_rank + escalation_probability`, so a gate-floored case sits
above any un-floored one and the model only breaks ties. That is the product's documented
precedence, not a scoring trick: a queue that let a model score outrank a T4 floor would
violate the core invariant.

Prior-free companion, in case you reject the assumed mix — recall of T3+T4 in the top k of
the 80-conversation corpus:

| top k | 10 | 20 | 30 | **36** | 40 |
|---|---|---|---|---|---|
| recall | 0.278 | 0.556 | 0.806 | **0.917** | 0.917 |

### Most informative features

Mean absolute coefficient across tiers, full model:

| feature | weight | group |
|---|---|---|
| `has_identity_target` | 0.364 | report |
| `peak_position` | 0.311 | trend |
| `last_risk` | 0.297 | trend |
| `duration_score` | 0.281 | report |
| `max_p_distress` | 0.226 | turn |
| `has_avoidance` | 0.211 | report |

Three of the top six are deterministic markers. `peak_position` and `last_risk` say that
*where* in a conversation the worst moment sits matters as much as how bad it is, which is
the trend group earning its place on `syn-050` and `syn-079`.

---

## 5. Cross-conversation clustering (day 7)

The layer that answers a question no single conversation can: *is this the same person doing
this to several students?*

Entity extraction with structured output, **pseudonymised at the point of extraction** with
a keyed HMAC, then BM25 plus character-trigram cosine plus entity overlap inside a 14-day
window, single-linkage agglomerative. No embeddings (`docs/ml.md` §5 has the argument).

| | |
|---|---|
| corpus | **85** conversations, 260 student turns |
| conversations naming an entity | 11 of 85, 16 mentions |
| **alerts raised** | **1** — 4 cases, 6 links, 9-day span |
| planted decoy joined a cluster | **0** |
| largest cluster | 4 of 85, so no corpus collapse |

The alert reads, verbatim: *4 separate reports, naming the same location, naming the same
person, within 9 days.*

### The result that matters, and it was not staged

| case | authored | the head said | escalation | clustered |
|---|---|---|---|---|
| syn-081 | T2 | **T0** | **0.08** | yes |
| syn-082 | T2 | T2 | 0.08 | yes |
| syn-083 | T3 | T3 | 0.94 | yes |
| syn-084 | T3 | T3 | 1.00 | yes |
| syn-085 (decoy) | T2 | T2 | 0.08 | **no** |

**`syn-081` is a student describing being pushed down a flight of stairs twice in one week,
and the conversation head scored it T0, escalation 0.08.** That is section 2's victim-voice
gap doing exactly what day 4 predicted, on a case written after the diagnosis rather than to
illustrate it. Alone, it would be logged and never queued.

The cluster surfaces it anyway, because two *other* students named the same person and the
same stairwell. Cross-conversation evidence rescuing a case that per-conversation ML threw
away is the whole argument for building this layer, and it emerged from the system's own
behaviour rather than from a demo script.
`test_the_cluster_rescues_a_case_the_classifier_dismissed` fails if it ever stops being true.
The console marks that case **"missed alone"**.

### Entities link; text only corroborates

Every conversation here is a teenager describing school in the same register, so a purely
lexical linker merges all 85 into one useless cluster. A shared entity is the only thing
that can form a link on its own; BM25 and trigram similarity can strengthen a link and never
create one. `test_the_whole_corpus_does_not_collapse` pins that, and the decoy is what
measures it: it shares the register and the vocabulary and names different people.

### The privacy property, measured

All four clustered reports resolved to `per_5034b50e06bc` and `pla_088b5679f48c`. The decoy
resolved to different tokens for both. The database holds no name at all. A counsellor is
told "the same person"; nobody, including us, learns who.

---

## 6. The live path, end to end (day 9 onward)

The numbers above are all offline. These are from the running system, against Neon and a
local scoring service.

| | |
|---|---|
| warm scoring latency | **~30 ms** against a 4.0 s timeout |
| cold start | **~10 s**, which exceeds the timeout by design |
| gate cost per turn | 123 µs, four orders of magnitude of headroom |
| **fixture reproduction through the HTTP path** | **exact**, tier and confidence to 4 dp on three spot-checked cases (0.9529, 0.9099, 0.8653) |

**The service reproduces the committed fixture exactly.** Three seeded T3 cases fed back
through the FastAPI path returned the same tier and the same confidence to four decimal
places. That is what proves the serving pipeline is the pipeline that was evaluated, and it
is why the finding below can be attributed to the training data rather than to a plumbing
bug.

`TurnScorer` was extracted from `score_turns.main()` so the serving path and the
fixture-building path run the same batching, truncation and temperature scaling. Before
that, the logic lived inside a CLI entry point, and a service reimplementing it would have
scored live cases differently from the corpus the model was evaluated on.

### Degradation, verified rather than assumed

| Injected failure | Observed |
|---|---|
| Scorer killed mid-session | crisis resources still render, the case is still created at T4, the card is honestly marked gate-only |
| Cold start | first call timed out at 4 s, the case was written gate-only, the next call scored in 30 ms |
| No `ANTHROPIC_API_KEY` | scripted replies, tiering unaffected, all 473 web tests pass |
| `DATABASE_URL` pointed at a dead host | all 473 web tests pass against the in-memory store |

### The finding that matters more than the plumbing

A live conversation describing months of daily bullying and eating lunch in the toilets was
scored **T0, "No concern identified"**, confidence 0.4539. The gate has no keyword for
sustained bullying, so nothing else caught it either. That case would be logged and never
queued.

This is not a serving bug. It is section 2 appearing on the live path for the first time,
and the exact reproduction of the fixture above is what proves the pipeline innocent.

**Consequence for any demo:** typing a realistic bullying disclosure into the live chat may
produce a T0. Do not show that path without saying why. The honest framing is the one
already in section 2: the gap is in the training data, every cheap remedy was tried, and the
deterministic half of the system is currently better than the learned half on exactly this
class of case.

### One ranking bug worth recording

The first live T4 case landed **17th in the queue, below every seeded T4**. `queue_rank` is
`floor_rank + escalation`, escalation is the model's output, a gate-only card has no model
output, and 0 had been passed for it. "Not scored yet" was being read as "scored low", and a
student in crisis right now sorted underneath sixteen synthetic cases.

**Unknown is not zero.** An unscored case now resolves to the top of its floor band: it
carries the most unresolved uncertainty and the least elapsed handling, so the tie-break
goes upward. Live T4 is now position 1 of 57. Its confidence is reported as `null` rather
than 0, because a counsellor reading "conf 0.00" on a case nothing has scored has been told
something false.

---

## 7. What is still wrong, stated plainly

- **recall@budget misses its target**, 0.865 against 0.90. Closing it needs victim-voice
  training data, not more features. Everything cheap has been tried.
- **T0/T1 separation is poor** (F1 0.560 / 0.581). The head confuses "asking about clubs"
  with "nervous about a school trip". This costs nothing operationally: both are below the
  counsellor queue, and no action differs between them.
- **`syn-007` ("this coursework is killing me") is predicted T3 by the head.** The gate
  correctly suppresses it, so no floor is applied, but the *head* is fooled by an idiom the
  regex bank handles. A false T3 wastes counsellor attention. This is the clearest case
  where the deterministic half is currently better than the learned half.
- **80 conversations is a small corpus** and all of it is synthetic. Every number in
  section 4 should be read as an order of magnitude, not a measurement.
- **The report markers are partly circular.** The corpus's own T1/T2 boundary is
  persistence (`syn-014` is a one-off exclusion, `syn-028` is the fourth time this term),
  so a persistence feature is being scored against the definition it was built from. The
  victim-voice diagnosis in section 2 is *not* circular: that came from the classifier.
- **Zero-shot Claude baseline is missing.** Note: the key has been present since day 7, so
  this is no longer credential-blocked, only undone. Until it is run we cannot say whether a
  frontier model beats 0.767 on turn classification.
- **Indirect suicidal ideation floors at T3 and shows the student no crisis resources.**
  `"i dont want to be alive anymore"` *is* recognised as `suicidal_ideation`, but the
  pattern is graded MODERATE and `_floor_from` demotes moderate matches by one tier, so T4
  becomes T3, and the crisis banner only renders at T4. The case still reaches a counsellor
  within 24 hours; the student is shown nothing in the moment.

  **Reviewed on 2026-08-10 and kept deliberately.** The same pattern bank catches
  `"whats the point of any of this"`, which is frequently about homework, and a red crisis
  banner on that desensitises students to the real ones. The costs are genuinely asymmetric
  in both directions and the call went to the narrower banner.

  Pinned by tests in `ml/tests/test_safety.py` so it stays a decision rather than drifting.
  If it is ever revisited, the intended route is a quieter support block for the grey band
  using `SUPPORT_RESOURCES`, **not** promoting these patterns to STRONG.

### Beyond the ML

Not model problems, but they belong on the same page rather than only in `docs/privacy.md`
§12, because they bound what any of the numbers above are worth in practice.

- **Redaction is not anonymisation.** On the live path it is regex-only, because entity
  extraction is an offline batch step over a finished conversation, so a lowercase name
  survives. Tested as a known gap rather than hidden.
- **Tiered disclosure level 3 is unwired.** `seal.ts:unseal()` has no caller, so identity
  disclosure is designed, tested and unreachable. The console does not claim otherwise.
- **No rate limiting on counsellor sign-in.** scrypt makes guessing slow, not stopped.
- **The clustering evaluation is one alert on one planted cluster.** A single positive and a
  single decoy is a demonstration, not a precision/recall measurement, and it should be read
  that way.
- **Cards are snapshots.** Changing card logic does not update already-stored cases; a real
  deployment would need a backfill.

---

## 8. Reproducibility

Seed `20260804` everywhere. Splits are grouped so near-duplicates cannot straddle the
train/test boundary. The turn probabilities used by day 4 are committed at
`fixtures/synthetic_turn_probs.json`, so the ablation reproduces exactly without the
268MB checkpoint.

**All conversation data in this repository is synthetic and hand-authored.** No student
wrote any of it, and none of it derives from a real transcript.
