# Lighthouse — architecture

How the system fits together, why each boundary is where it is, and what happens when each
piece fails.

`docs/context.md` holds the locked decisions in their original form. This document is the
readable version: it assumes you have not read the log and want to understand the shape of
the thing. `docs/ml.md` explains the techniques, `docs/results.md` holds the numbers, and
`docs/privacy.md` covers the privacy layer in depth.

## Contents

1. [The shape of it](#1-the-shape-of-it)
2. [The two runtimes, and the contract between them](#2-the-two-runtimes-and-the-contract-between-them)
3. [The live path: a student sends a message](#3-the-live-path-a-student-sends-a-message)
4. [The triage pipeline](#4-the-triage-pipeline)
5. [The counsellor path](#5-the-counsellor-path)
6. [The cross-conversation layer](#6-the-cross-conversation-layer)
7. [Storage](#7-storage)
8. [Every way this degrades](#8-every-way-this-degrades)
9. [Where the invariants actually live](#9-where-the-invariants-actually-live)

---

## 1. The shape of it

```
                          STUDENT (pseudonymous handle, no account)
                                        |
                                        | POST /api/chat  (SSE)
                                        v
   +--------------------------------------------------------------------------+
   |  DETERMINISTIC SAFETY GATE                    web/src/lib/gate/safety.ts  |
   |  66 patterns, 21 suppressors, six categories, 123 microseconds per turn   |
   |  emits SafetyVerdict{score, level, indicators} + floor + ceiling          |
   +--------------------------------------------------------------------------+
       |                        |                                 |
       | crisis event           | case written                    | scoring call
       | (flushed FIRST)        | (before the model)              | (concurrent)
       v                        v                                 v
   CRISIS BANNER          PII REDACTION + SEAL              CLASSIFIER SERVICE
   real 24/7 numbers      privacy/redact.ts                 ml/lighthouse/serve
   unconditional          privacy/seal.ts                   FastAPI, 4s timeout
                                |                                 |
                                v                                 |
                          POSTGRES (Neon)                         |
                          conversations / turns / pii_map         |
                                ^                                 |
                                |     scored card replaces the gate-only one
                                +---------------------------------+
                                |
                                | (the LLM writes chat replies only, on a
                                |  separate track, and never sees a tier)
                                v
   +--------------------------------------------------------------------------+
   |  ESCALATION CARD    tier . calibrated confidence . <=3 verbatim quotes    |
   |                     . gate indicators . timeline . gateFloor              |
   +--------------------------------------------------------------------------+
                                        |
                                        v
   +--------------------------------------------------------------------------+
   |  COUNSELLOR CONSOLE                                                       |
   |  queue (floor first, model as tie-break)                                  |
   |    -> open case      -> audit row  viewed_card                            |
   |    -> read transcript -> audit row viewed_transcript   (required first)   |
   |    -> override tier   -> audit row overrode_tier       (floor re-applied) |
   |    -> break-glass     -> audit row broke_glass         (lead reviews)     |
   +--------------------------------------------------------------------------+
             |                                              |
             v                                              v
   CROSS-CONVERSATION CLUSTERING                  STUDENT RECEIPT  /c/[caseId]
   keyed-HMAC entities, BM25, char-trigrams       the same audit log, in plain
   14-day window, single-linkage                  English, readable by the student
```

Two facts about that diagram are load-bearing.

**The gate is upstream of everything, including the language model.** It is not a filter on
model output. By the time the model is contacted, the verdict exists, the crisis numbers are
on the wire, and the case has been written.

**The LLM appears once, on a side branch.** It writes the student-facing chat replies. It
does not tier, rank, cite, cluster or decide. Entity extraction for clustering also uses it,
offline and in batch, and even there the output is pseudonymised before it is stored.

## 2. The two runtimes, and the contract between them

| | Python (`ml/`) | TypeScript (`web/`) |
|---|---|---|
| Runs | training, calibration, evaluation, card building, clustering, the scoring service | the student chat, the console, the live path |
| Owns | the model, the features, the head, the card template bank | the UI, storage, auth, audit, retention |
| Both own | **the safety gate** | **the safety gate** |

Everything except the gate lives in exactly one runtime. The gate lives in both, and that is
deliberate.

### Why the gate is duplicated rather than called

The gate must render crisis numbers when the Python side is unreachable, and the Python side
is a free Hugging Face Space that sleeps after 48 hours of idleness and cold-starts in about
30 seconds. A gate behind that network call fails at precisely the moment it matters. So it
is ported, not fetched. Do not "simplify" it into an HTTP call.

The cost is two copies of one safety rule. Two test suites make the contract unfalsifiable
by editing either side alone:

| What you edit | What fails |
|---|---|
| A Python pattern, without re-exporting the fixture | `ml/tests/test_ts_conformance.py` (snapshot stale) |
| The fixture, without mirroring the pattern in TS | `web/src/lib/gate/gate.conformance.test.ts` (verdicts differ) |
| A regex body in either runtime | the Python suite: all 87 sources compared character by character |
| A MIRRORED constant in one `config` file | both |

`fixtures/gate_expectations.json` is generated by
`python -m lighthouse.gate.export_expectations`. **Regenerate it after any change under
`ml/lighthouse/gate/`.**

**The snapshot alone is not enough, and this was measured rather than assumed.** Four drifts
were deliberately injected. Two passed undetected, because nothing in the corpus or the
probe set contains the affected pattern, so it could be weakened in either runtime with all
354 verdicts unchanged. Comparing regex *sources* closes that hole because it needs no
corpus coverage at all. The source comparison is the stronger of the two tests.

### What is deliberately not ported

The conversation head. Porting 38-feature extraction, logistic regression, isotonic
calibration and the reason bank into TypeScript would create a third drift surface with no
test capable of catching a divergence before a judge did. Instead the conversation row
carries **the card itself as JSON**: the web runtime writes a gate-only card, the Python
service returns a richer one, and the queue reads the column without knowing which it got.

## 3. The live path: a student sends a message

`POST /api/chat`, Server-Sent Events. The ordering in this list is the safety property, not
an implementation detail.

1. **Parse and truncate.** A student who pastes an essay is truncated at `MAX_TURN_CHARS`,
   never rejected with a validation error.
2. **Run the gate.** Every turn, then the conversation. 123 microseconds of local regex, no
   network, no model.
3. **Flush the `crisis` event** if the verdict is high. This is written to the wire *before
   the model is contacted*, so nothing the model does, including hanging, refusing or
   throwing, can delay or cancel it.
4. **Write the case.** Turns are redacted and their identifying spans sealed on the way in.
   The stored card is gate-only and marked `awaitingClassifier`. *A case that only exists
   once a model responds does not exist during an outage*, and the conversations that most
   need to survive an outage are exactly the T4s.
5. **Call the classifier and the LLM concurrently.** The scoring call runs inside time the
   request was already spending on the reply, so it costs the student nothing.
6. **Stream the reply.** If the scored card arrives, it replaces the gate-only one in place.

SSE rather than a plain streamed body because the client has to tell three things apart on
one connection: the gate verdict, the assistant's words, and the degradation notice. A bare
text stream would force the client to parse sentinels out of prose a model wrote.

### The conversational model's job, and its leash

Listen, keep them talking, never advise. It is given a tight system prompt, capped at
`INTAKE_MAX_TOKENS`, and it is never shown a tier or asked for one. With no
`ANTHROPIC_API_KEY` the replies are scripted and the UI says so. That is the default state
the test suite runs in.

## 4. The triage pipeline

### Stage 1: the deterministic gate

Six categories, and the floor each one can reach:

| Category | Floors at |
|---|---|
| `self_harm_intent`, `suicidal_ideation`, `abuse_disclosure` | T4 |
| `threat_of_violence`, `weapon_mention` | T3 |
| `imminent_time_marker` | modifier only: promotes a T3 floor to T4, never floors alone |

**Severity decides how far a category floors, not merely whether it does.** STRONG matches
floor at the category's full tier, MODERATE one tier below, WEAK never (they still score, so
the case can go grey). The reason is the specific cost of T4: T4 means break-glass, and
break-glass means lifting a child's anonymity. A bare "self harm" with no first-person
framing deserves a counsellor within 24 hours, not a de-anonymisation. A "knife" in a
food-tech story deserves neither.

Scoring is **noisy-OR over per-category maxima**, `1 - prod(1 - w)`. Maximum rather than sum,
so a distressed student repeating themselves does not outrank a calm one who says it once.

**Suppressors cancel by span containment, not co-occurrence.** One mechanism covers idiom
("this coursework is killing me"), negation ("i would never kill myself") and attribution
("he told me to kill myself"), which is why each suppressor regex spans the trigger phrase
rather than sitting beside it. Containment is what lets *"he told me to kill myself, and
honestly i do want to die"* cancel the first clause and keep the second.

The output has **no `tier` field**, deliberately. The gate constrains; it does not decide.

### Stage 2: the turn classifier

Fine-tuned `distilbert-base-uncased` over 45,286 training turns, six classes, class-weighted
cross-entropy, temperature-scaled at T = 1.342. Per-turn risk is `1 - P(none)`.

### Stage 3: the conversation head

38 features in five groups: gate indicators, turn-score aggregates, trend (where the worst
moment sits), deterministic harm-report markers, and prior-session history. Multinomial
logistic regression with nested isotonic calibration.

The report-marker group is worth **+0.154 recall@20**, more than any other single change,
and exists because of the victim-voice gap (`docs/results.md` §2). Three of the six most
informative features are deterministic markers, not model outputs.

### Stage 4: the floor, applied last

`apply_verdict` runs the gate floor over the head's prediction unconditionally. This is what
takes T4 recall from 0.812 to **1.000**. One documented exception exists in the other
direction: `t4_override=True` lets strong calibrated classifier evidence through the
*ceiling*, so a phrasing the pattern banks never anticipated cannot be capped into
invisibility. It is recorded in the returned reason.

### Stage 5: the card

Every sentence on a card is either a template we wrote or a span the student wrote. There is
no third category.

- **Reasons come from a closed bank** in `model/card.py`. A counsellor deciding whether to
  break a child's anonymity should read a sentence a human committed to in advance, not one
  a model improvised. `MISSES` counts evidence the bank has no template for, so the gap is
  visible rather than silent.
- **Quotes are sliced by offset** from the student's own turn and asserted verbatim in
  tests. This is why the gate's normalisation is length-preserving: offsets have to survive
  redaction, gate scoring and card building intact.
- **Maximum three quotes.** More and a counsellor stops reading the evidence list.
- **Queued cases always carry at least one quote.** Gating strictly on `CONCERN_THRESHOLD`
  produced T3 cards with no evidence at all, because T2 and most of T3 are gate-silent by
  design and the victim-voice gap keeps their scores low. A below-threshold quote is
  labelled `no explicit signal` so it reads as context, not as a finding.

Cards for the seeded corpus are **precomputed** into `fixtures/escalation_cards.json` and
compiled into the bundle. Derived, static and read on every request: it belongs in the
bundle, not in Postgres, and it means the console never depends on a sleeping Space.
`ml/tests/test_cards.py` fails when the fixture is stale.

## 5. The counsellor path

### The queue

Ranked by `floor_rank + escalation_probability`. A gate-floored case sits above any
un-floored one and the model only breaks ties. That is documented precedence rather than a
scoring trick: a queue that let a model score outrank a T4 floor would violate the core
invariant.

**Unknown is not zero.** A live case the classifier has not scored yet resolves to the *top*
of its floor band, because it carries the most unresolved uncertainty and the least elapsed
handling. Passing 0 instead put a live T4 seventeenth, below every seeded T4. Its confidence
is `null` rather than 0, because a counsellor reading "conf 0.00" on a case nothing has
scored has been told something false.

**Live cases are not pinned to the top.** That would be recency bias dressed as urgency, and
this queue exists to stop a counsellor working by recency. A live T2 sorts below a seeded T4
because it is below it. What live cases get instead is a visible "gate only" marker.

### Reading comes before deciding

`recordOverride` and `breakGlass` both refuse until this counsellor has a `viewed_transcript`
row on this case.

The reason is not ceremony. **The card is assembled to support its tier.** Quotes are
selected by descending risk, gate hits are sorted the same way, and reasons fire from a bank
keyed on what the gate matched. Every item on a card is there *because it agrees with the
tier*, and nothing in the pipeline selects for evidence that contradicts one. That is right
for triage ("should I look at this?") and wrong for adjudication ("is this right?"), and the
console was asking both from the same artifact.

`syn-066` is the whole argument in one case:

| what the card shows | what the conversation shows |
|---|---|
| T4, first-person cutting, quote: *"i've been cutting my arms again"* | turn 3: *"no it's not deep. i just wanted to say it to someone"* |
| | turn 5: *"about a month. i stopped for nearly a year before that"* |

Turns 3 and 5 score low, which is exactly why the card omits them. They are also the only
turns that tell a counsellor what they are looking at.

This is **not permission**: nothing is blocked, no second person is involved, and the
transcript costs one logged sentence of ten characters. Only the *order* is fixed. It is
enforced in the writers rather than at the call sites, for the same reason mandatory reasons
are: a check at each call site is the check that is missing from the seventh one. It is also
**per counsellor**, because an override's claim is "I have seen this conversation and I
disagree", which is first-person or it is nothing.

### Overrides

A counsellor's requested tier is passed back through `applyFloor`. A request to move a T4
self-harm disclosure to T1 is **accepted, logged with its reason, and results in T4**, with a
notice explaining why. The reason is kept regardless: a counsellor who believes a case is
over is telling us something, and it is the only ground truth this system ever receives from
someone who knows the student.

The card carries `gateFloor` explicitly. **Do not infer a floor from `tierFloorReason`.**
That field is populated only when the gate *changed* the tier, so on any case the model
already scored correctly it is null while the floor is real. Shipping exactly that inference
let a counsellor downgrade a self-harm disclosure to T1 for one afternoon.

### Break-glass

The one path that overrules the gate, and its existence is what makes the floor credible the
rest of the time. A gate tuned to miss nothing will eventually floor a song lyric or a drama
script, and a counsellor with four false T4s and no way out learns to distrust the tier.

- A separate table from overrides, because it is a different claim ("the gate is wrong about
  this case" against "I disagree about urgency") and it has to be countable on its own.
- Refused where there is no floor, and refused at or above the floor. An override covers
  both at a tenth of the ceremony.
- A 40-character reason, four times the override threshold, because a lead reads it weeks
  later with no memory of the case.
- **Review is after the fact, never before.** A two-person rule sounds stronger and is
  weaker: requiring a lead's approval before the button works means a counsellor at 7pm on a
  Friday either waits or works around the system, and the second is what happens. The control
  is that every row lands unreviewed and the queue shows the count. A lead cannot review
  their own.
- It does not un-show the crisis resources. Those rendered when the gate fired.

## 6. The cross-conversation layer

Entity extraction runs offline in batch over finished conversations, using the LLM with
structured output, and **pseudonymises at the point of extraction** with a keyed HMAC.

Clustering on entities and protecting anonymity look contradictory: to know four students
named the same boy, you appear to need the boy's name. You do not. Store
`HMAC-SHA256(key, normalised_name)`. "Kai", "kai" and "Kai!" fold to one token, two
conversations naming him produce the *same* token, and the database holds no name at all.
HMAC rather than a bare hash because there are only a few thousand common first names and a
plain SHA-256 digest of one is enumerable in a second. The key is the whole protection.

Linking is BM25 plus character-trigram cosine plus entity overlap inside a 14-day window,
single-linkage agglomerative. No embeddings: `docs/ml.md` §5 has the argument.

**Entities link; text only corroborates.** Every conversation in this corpus is a teenager
describing school in the same register, so a purely lexical linker merges all 85 into one
useless cluster. A shared entity is the only thing that can form a link on its own; BM25 and
trigram similarity can strengthen a link but never create one.
`test_the_whole_corpus_does_not_collapse` pins that.

## 7. Storage

Nine tables on Neon serverless Postgres, via Drizzle.

| Table | Holds |
|---|---|
| `conversations` | case id, handle, tier, the card as JSON, retention expiry, tombstone |
| `turns` | redacted text only |
| `pii_map` | AES-256-GCM sealed identifying spans, fresh IV per seal |
| `counsellors`, `counsellor_sessions` | scrypt password hashes, `sha256(token)` sessions |
| `counsellor_access` | the append-only audit log |
| `tier_overrides` | a counsellor's requested tier, the effective tier, the reason |
| `break_glass` | the reason, and the lead's review |

### One store interface, two implementations

`memory.ts` and `postgres.ts`. The split exists so behaviour tests run offline against the
real code rather than against stubs: all 473 web tests pass with `DATABASE_URL` pointed at a
dead host.

**The in-memory store is for tests and local runs only.** On serverless each instance has
its own module scope, so an override written by one POST can be invisible to the next page
render, which is a counsellor's correction silently disappearing rather than a stale cache.
The app says so in the console and in the override panel when `DATABASE_URL` is unset.

### The audit log outlives what it describes

`counsellor_access` and `tier_overrides` key on `case_id text` **with no foreign key**. They
previously carried `conversation_id ... on delete cascade`, which meant the retention job
deleting a conversation also deleted every record of who had opened it. An audit log a
routine cleanup job can erase is not an audit log. Each half looked correct alone, which is
why it survived three days of review.

The actor's email is **denormalised into every audit row** at write time, because a record
whose meaning depends on a joinable mutable row can be rewritten by editing that row, and
"who was this" has to stay answerable after the account is gone.

Rows carry a `seq bigserial` alongside `at`. Two actions in the same millisecond are
ordinary (opening a case writes `viewed_card`, acting on it writes another in the same tick)
and ordering by `(at, id)` put them in random-UUID order. A student reading "who opened my
case" has to see what actually happened first.

**The interface exposes no delete for any audit table**, so the retention job has nothing to
call. A test asserts that.

## 8. Every way this degrades

Each row is a designed state with its own UI copy and its own tests, not an untested branch.

| What is missing or broken | What still works | What the user sees |
|---|---|---|
| `ANTHROPIC_API_KEY` | gate, tiering, crisis banner, case creation, console, the entire ML pipeline | scripted replies, and a notice saying so |
| The classifier service (asleep, cold, 500, timeout) | gate-only triage: case created, floor applied, crisis banner, queue position at the top of its floor band | the card is marked "gate only", confidence is blank rather than 0 |
| `DATABASE_URL` | everything, against the in-memory store | a loud notice in the console and the override panel |
| `LIGHTHOUSE_PII_KEY` | chat and triage | sealing is unavailable; the app refuses to pretend it sealed anything |
| The Python runtime entirely | the whole web app, including the gate, verbatim | nothing; the seeded cards are compiled into the bundle |
| A cold start (first request of the day) | the 4-second timeout fires, the case is written gate-only, the next request scores in ~30ms | "gate only" on one case |

The first request of the day timing out is the **normal case**, not a fault, and
`classifier.ts` is written to say so rather than describing it as a rare error.

## 9. Where the invariants actually live

If you are checking whether a claim in this document is true, these are the files to open.

| Invariant | Enforced in | Proven by |
|---|---|---|
| No model output lowers a gate floor | `gate/safety.py::apply_verdict`, `lib/gate/safety.ts` | `ml/tests/test_safety.py`, exhaustive over every flooring text times every tier, and again with `t4_override` on |
| No human lowers a gate floor | `lib/overrides.ts` | `overrides.test.ts`; verified live, a requested T1 on a T4 case records as T4 |
| Crisis resources precede model output | `app/api/chat/route.ts` | the crisis event is enqueued before `generateReply` is called |
| Every crisis line is 24/7 | `config.CRISIS_RESOURCES` | a test rejects any entry whose hours are not round-the-clock |
| The two gates agree | both `gate/` directories | 354 verdicts diffed, 87 regex sources compared character by character |
| Deciding requires reading | `lib/transcript.ts`, called from the writers | `transcript.test.ts`; verified live, both writers 400 before a read |
| Cards quote verbatim | `model/card.py` | 68 quotes asserted character-for-character against the student's own turn |
| The audit log cannot be deleted | `store/types.ts` | a test asserts the interface exposes no delete for any audit table |
| The cluster rescues what the model dropped | `cluster/patterns.py` | `test_the_cluster_rescues_a_case_the_classifier_dismissed` |

**1,570 tests, all offline.** 1,093 Python and 477 TypeScript, with no API key, no database
and no network.
