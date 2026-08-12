# Lighthouse

**An anonymous chat helpline for students, where the chat is only the intake.**

The product is the triage layer downstream: a deterministic safety gate, a fine-tuned risk
classifier, evidence-cited escalation cards, a counsellor console with a real audit trail,
and cross-conversation pattern detection that surfaces repeat offenders no single
counsellor could see.

Built for the ML Empowerment Build Challenge 2.0.

> **Every conversation in this repository is synthetic and hand-authored.** No student
> wrote any of it, none of it derives from a real transcript, and no real school, staff
> member or child is represented. See [Data and honesty](#data-and-honesty).

---

## The one idea

**The classifier decides. The LLM only explains.**

A fine-tuned DistilBERT model plus a logistic conversation head produces the risk tier. A
deterministic regex gate can raise that tier but never lower it. The language model writes
the chat replies and nothing else: it never sees a tier, never proposes one, and its output
is never read back into the classifier.

The test of that claim is what happens when the API is down. Pull the key and triage still
works: the gate still fires, the case is still created, the tier is still assigned, and the
crisis numbers still render. That path is not a fallback branch we hope works. It is the
default the repository runs in with no credentials present, which is how 1,566 tests
exercise it on every run.

## Non-negotiables

These are product constraints, not aspirations. Each one is enforced somewhere you can go
and read.

| Constraint | Where it is enforced |
|---|---|
| **Crisis resources are unconditional.** On a T4 gate hit, real 24/7 crisis lines render to the student before any model output, and still render when the LLM call fails, times out, or refuses. | `app/api/chat/route.ts` flushes the crisis event before the model is contacted; `components/crisis-banner.tsx` sits outside the scroll container |
| **No model output can lower a gate floor.** Not the classifier, and not a human. | `gate/safety.py::apply_verdict`, mirrored in `lib/gate/safety.ts`; `lib/overrides.ts` re-applies the floor to a counsellor's own request |
| **The LLM never decides a tier.** | The tier is produced in Python by `model/predict.py`. The web runtime has no code path that lets a model choose one |
| **This is a listening and routing tool, not therapy.** No copy claims clinical capability. | Reason text comes from a closed template bank in `model/card.py`, tested against a clinical-language list |
| **A counsellor may read a case without deciding anything. They may not decide without reading.** | `recordOverride` and `breakGlass` refuse until a `viewed_transcript` row exists for that counsellor on that case |
| **All demo conversations are synthetic.** | `fixtures/synthetic_conversations.jsonl`, hand-authored, no API key involved |

## Results

Full tables, methodology and the things that are still wrong: **[docs/results.md](docs/results.md)**.
Why each technique was chosen: **[docs/ml.md](docs/ml.md)**.

**Turn classifier** (45,286 train / 9,705 test turns, DistilBERT, 3 epochs on a free T4):

| | label-only floor | TF-IDF + LogReg | **DistilBERT** |
|---|---|---|---|
| test macro-F1 | 0.1661 | 0.7148 | **0.7670** |
| risky-bucket recall | 0.179 | 0.722 | **0.807** |

Calibrated by temperature scaling, T = 1.342: test ECE **0.0699 to 0.0263**, no argmax moved.

**Conversation head** (80 conversations, 5-fold CV repeated over 10 seeds):

| | head alone | **post-gate, what a counsellor sees** |
|---|---|---|
| macro-F1 | 0.631 | **0.714** |
| **T4 recall** | 0.812 | **1.000** |

The head misses three of sixteen T4 conversations. The gate catches all three. That row is
the thesis made measurable.

**Cross-conversation clustering:** one alert on 85 conversations, reading *4 separate
reports, naming the same location, naming the same person, within 9 days*. The planted
decoy joined nothing. The alert rescues `syn-081`, a student describing being pushed down a
flight of stairs twice in a week, which the conversation head scored **T0, escalation
0.08**.

**What is honestly wrong,** stated here rather than buried: recall@counsellor-budget is
**0.865 against a 0.90 target**, a miss. The cause is diagnosed and is not closable with
more features. See [the victim-voice finding](#the-finding-that-shaped-the-project).

## The finding that shaped the project

Every public dataset available to us is **perpetrator voice**. Jigsaw comments *are* the
abuse. r/SuicideWatch posts are first-person distress. This product receives neither: it
receives a student **describing** what is happening to them. Measured on our own checkpoint:

| the same harm, two voices | risk |
|---|---|
| "nobody wants to talk to you, you freak" | **0.964** |
| "nobody in my class has spoken to me in about two weeks" | **0.021** |

A 45x gap. It is why `turn-only` features score 0.214 macro-F1 on the conversation head,
barely above chance, while the same classifier gets 0.767 on its own test split. **The
model is not broken.** It is answering "is this message toxic?" while we ask "is this
student being harmed?"

Three things in this repository exist because of that finding: the deterministic
harm-report markers (`model/markers.py`, worth +0.154 recall@20, more than any other
change), the safety gate's status as an equal partner rather than a guardrail, and the
cross-conversation layer that rescued `syn-081`. It is also the reason typing a realistic
bullying disclosure into the live chat can still produce a T0. Do not demo that path
without saying why.

## Architecture

```
Student (pseudonymous handle, no account)
  |
  v
DETERMINISTIC SAFETY GATE            <- runs BEFORE the conversational model
  66 graded patterns, 21 suppressors, six categories, 123 microseconds per turn
  emits FLOORS and CEILINGS, never a decision
  on high: crisis resources render immediately, tier floored at T4
  |
  +--> Conversational LLM (listen, keep them talking, never advise, never tier)
  |
  v
PII REDACTION -> storage (redacted transcript + separately encrypted PII map)
  |
  v
RISK CLASSIFIER
  turn-level DistilBERT -> per-turn harm scores (temperature-scaled)
  conversation head -> 38 features -> tier T0-T4 (isotonic-calibrated)
  |
  v
ESCALATION CARD   tier . calibrated confidence . <=3 verbatim quotes . timeline
  |
  v
COUNSELLOR CONSOLE   queue -> read transcript -> override / break-glass, all logged
  |
  +--> CROSS-CONVERSATION CLUSTERING
       keyed-HMAC entities + BM25 + char-trigrams + 14-day window
       "4 unlinked reports in 9 days, same location, overlapping description"
```

Full detail, including the two-runtime contract and every degradation path:
**[docs/architecture.md](docs/architecture.md)**.

### The risk taxonomy

| Tier | Meaning | Counsellor action | SLA |
|---|---|---|---|
| **T0** | General chat, no concern | Log only | none |
| **T1** | Venting, mild social friction | Log, no action | none |
| **T2** | Sustained bullying, exclusion, harassment | Queue, routine | 48h |
| **T3** | Severe or persistent harassment, threats, targeted discrimination | Queue, priority | 24h |
| **T4** | Self-harm intent, abuse disclosure, imminent danger | Break-glass, crisis resources to the student | immediate |

## Privacy

A student who does not trust the tool does not use it, so the privacy layer is a product
feature rather than compliance work. Full design and threat model:
**[docs/privacy.md](docs/privacy.md)**.

- **Pseudonymous by default.** The student picks a handle. There is no account and no name.
- **Redaction before storage**, and an **encrypted PII map** (AES-256-GCM, fresh IV per
  seal) that a database dump alone cannot open.
- **Tiered disclosure.** Card, then transcript, then identity, each with a longer written
  reason and its own audit row.
- **An audit log the student can read**, at `/c/[caseId]`, in plain English.
- **Retention that deletes content, not existence.** Non-escalated conversations erase
  after 30 days; the tombstone and the access log survive, because a counsellor who read a
  case stays accountable afterwards.
- **Break-glass** for when the gate is wrong, reviewed after the fact by a lead, never
  before, and counted.

**This is not anonymisation and is not described as such.** Without extracted entities a
lowercase name can survive redaction, and that gap is tested rather than hidden.

## Run it

Nothing here needs a credential. The full test suite, the gate, the chat, the crisis banner
and the whole ML evaluation run offline with no API key, no database and no network.

```bash
# The web app: student chat at /, counsellor console at /console
cd web
npm install
npm run dev
```

With no `ANTHROPIC_API_KEY` the replies are scripted and the UI says so. With no
`DATABASE_URL` the store is in-memory and the UI says that too. Both are designed states
with their own tests, not untested branches. `web/env.example` documents every variable and
why it exists.

```bash
# The ML side. Python 3.12, managed by uv.
cd ml
uv sync
uv run pytest -q                                  # 1093 passed, offline
uv run python -m lighthouse.data.synthetic        # the gate audit over all 80 conversations
uv run python -m lighthouse.model.conversation_head   # the ablation table in results.md
```

```bash
# Both suites
cd web && npm test        # 473 passed
```

Deploying, and the post-deploy checklist: **[docs/deploy.md](docs/deploy.md)**.

## Repository layout

```
docs/          context, plan, log, results, ml, architecture, privacy, deploy, submission
ml/            Python: taxonomy, safety gate, training, calibration, eval, clustering, serving
  lighthouse/gate/       the deterministic gate (patterns, scoring, TS export)
  lighthouse/model/      turn training, calibration, features, head, cards, inference
  lighthouse/cluster/    entity extraction and cross-conversation patterns
  lighthouse/serve/      FastAPI scoring service
web/           Next.js 16: student chat, student receipt, counsellor console
  src/lib/gate/          the gate, ported to TypeScript and held identical by tests
  src/lib/privacy/       redaction, sealing, tiered disclosure
  src/lib/store/         one interface, memory and Postgres implementations
fixtures/      the synthetic corpus, precomputed cards, gate expectations
data/          gitignored: raw datasets, splits, checkpoints
```

### Why the safety gate exists twice

The gate is implemented in Python and again in TypeScript, deliberately, and it is the one
piece of duplication in the codebase. It must render crisis numbers when the Python side is
unreachable, and the Python side is a free Space that sleeps after 48 hours and takes about
30 seconds to wake. A gate behind that call fails at exactly the moment it is needed.

Two test suites make the copies unfalsifiable by editing one side: 354 verdicts are diffed
across both runtimes, and all 87 regex sources are compared character by character. Four
drifts were deliberately injected to check this, and two of them passed the snapshot
comparison undetected because no test text contained the affected pattern. Comparing regex
sources is what caught them. Do not delete those tests in favour of the snapshot.

## Data and honesty

Training data is public benchmark data. Conversation-level labels are synthetic and
hand-checked. Nothing here is clinically validated.

| Dataset | Rows kept | Supplies | Licence |
|---|---|---|---|
| `thesofakillers/jigsaw-toxic-comment-classification-challenge` | 159,254 | harassment, identity attack, **threat** | CC0 |
| `joshyii/suicide_depression_detection` | 348,110 | **self-harm**, distress, teen-voice negatives | public Reddit, research use |
| `AnikaBasu/CyberbullyingDataset` | 2,955 | identity attack, harassment (tweet length) | CC0 |
| `thu-coai/esconv` | 1,300 convos | conversation structure, T0/T1 negatives | **CC-BY-NC-4.0, non-commercial only** |
| Synthetic conversation set | 85 convos | the conversation-level eval set | hand-authored, this repo |

Caveats we state rather than let a reader discover:

- **A subreddit is a proxy for a label, not a clinical annotation.** An r/SuicideWatch post
  is not verified suicidal ideation.
- **There is a real domain gap.** Wikipedia comments and long-form Reddit posts are not chat
  turns, and neither is victim voice. The synthetic corpus exists partly to measure that.
- **85 conversations is a small corpus.** Read every conversation-level number as an order
  of magnitude, not a measurement.
- **`esconv` is non-commercial.** Any commercial use of this work needs that dependency
  removed first.
- **Crisis numbers are Singapore-specific** and were verified on 2026-08-08 against each
  operator's own site. Helpline numbers change. Re-verify before any real deployment.

## Deployment model

**School-mediated, not consumer.** The counsellor is the school's existing counsellor with
an existing duty of care, and accounts are created from a CLI because the set of adults who
may read children's disclosures is a decision a school makes in a room, not a sign-up form.

Lighthouse never handles an active crisis alone. It routes to a human, and to a phone
number, faster than a queue of unread messages would.

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | how the system fits together, and every degradation path |
| [docs/results.md](docs/results.md) | every number, how it was produced, and what is still wrong |
| [docs/ml.md](docs/ml.md) | the techniques, in plain language, and why each was chosen |
| [docs/privacy.md](docs/privacy.md) | the privacy model and its threat model |
| [docs/deploy.md](docs/deploy.md) | deploying, and the post-deploy checklist |
| [docs/demo.md](docs/demo.md) | the three-minute demo: script, shot list, pre-flight |
| [docs/submission.md](docs/submission.md) | the submission copy, and the questions a judge will ask |
| [docs/context.md](docs/context.md) | the locked decisions, with the reasoning kept |
| [docs/log.md](docs/log.md) | a dated build log, including everything that broke |
