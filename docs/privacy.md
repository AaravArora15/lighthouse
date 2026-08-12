# Lighthouse — privacy

A student who does not trust this tool does not use it, and a student who does not use it
gets no help at all. Privacy here is not compliance work bolted to the side. It is the
feature that makes the rest of the product function.

This document is the design, the threat model, and an honest account of what it does not
achieve. `docs/architecture.md` covers the system around it.

## Contents

1. [The promises, and where each is kept](#1-the-promises-and-where-each-is-kept)
2. [Pseudonymity](#2-pseudonymity)
3. [Redaction before storage](#3-redaction-before-storage)
4. [The encrypted PII map](#4-the-encrypted-pii-map)
5. [Tiered disclosure](#5-tiered-disclosure)
6. [The audit log, and the student's copy of it](#6-the-audit-log-and-the-students-copy-of-it)
7. [Retention](#7-retention)
8. [Break-glass](#8-break-glass)
9. [Counsellor authentication](#9-counsellor-authentication)
10. [Clustering without names](#10-clustering-without-names)
11. [Threat model](#11-threat-model)
12. [What this does not achieve](#12-what-this-does-not-achieve)

---

## 1. The promises, and where each is kept

| Promise made to the student | Kept by |
|---|---|
| You do not need an account or a name | `lib/live.ts`, a student-chosen handle and a server-minted case id |
| What you write is stripped of identifying details before it is stored | `lib/privacy/redact.ts`, run on the way in |
| Anything identifying is locked separately | `lib/privacy/seal.ts`, AES-256-GCM under a key held apart from the database |
| A counsellor sees a summary first, the full conversation only with a written reason | `lib/privacy/disclosure.ts`, `lib/transcript.ts` |
| You can see who opened your case and why | `/c/[caseId]`, reading the same rows the counsellor's page reads |
| If nothing comes of it, what you wrote is deleted | `lib/retention.ts`, 30 days, enforced by a nightly cron |
| If you are in danger, you get real phone numbers immediately | `config.CRISIS_RESOURCES`, rendered before any model output |

Every row of that table has tests. All 473 web tests run with no key, no database and no
network, and 192 of them cover this layer specifically: privacy (42), auth (35), audit (31),
the student's receipt (29), retention (27), break-glass (19) and the transcript rule (9).

## 2. Pseudonymity

The student picks a handle. There is no sign-up, no email, no password, and no name field.
The case id is **minted by the server and never chosen by the client**: a client-supplied id
would let anyone append turns to a case id they guessed, which on this product means writing
into another child's disclosure.

The case id is a capability. Anyone holding it can read that receipt at `/c/[caseId]`, which
is deliberate (the student has no account to log into) and is why it is 
cryptographically random rather than sequential.

## 3. Redaction before storage

Nothing raw is ever written. Each turn is redacted on the way in, and the spans that were
removed are sealed separately.

The division of labour is deliberate:

| Kind of PII | Found by | Why |
|---|---|---|
| phone, email, URL, postcode, address, handle | regex | reliable shape, no model call, no capitalisation dependency |
| names, places, schools | the entity extractor (`cluster/entities.py`), matched literally and case-insensitively | open class, no reliable shape |

### The bug that produced that split, because it is the interesting part

The first version was regex-only, had 35 passing tests, and **redacted nothing**. Measured
against the real corpus: **0 of 260 student turns had a single span removed.**

Every name detector required a capital letter. Students type in lowercase. `"kai took my
bag off me"` has no capital anywhere. All 35 tests passed because the examples were written
with capitals: the tests asserted my assumption rather than the data.

Capitalisation is a property of careful writing, not of chat, so it could never have been
the signal. The signal that does work was already being computed upstream for the clustering
layer, which asks a model for the people and places a transcript names and gets "kai" out of
exactly those turns. Redaction now consumes that list.

    "kai says he'll batter me if i go near the science block stairwell again"
    -> "[name] says he'll batter me if i go near the [place] again"

Identity gone, harm completely intact. That last property is the point: the classifier and
the gate still see the risk, because what makes a turn concerning is not the name in it.

### Redaction runs last, and the ordering is load-bearing

After the gate, after quote selection. The gate needs the real text, and gate spans and
cited quotes are offsets into it that a placeholder of a different length would invalidate.
This is also why the gate's normalisation is length-preserving. Moving redaction earlier
breaks both silently.

### The gap, stated rather than hidden

With no extracted entities, a **lowercase name survives**. On the live path this is the
normal case: entity extraction is an offline batch step over a finished conversation, so a
live turn gets regex-only redaction. There is a regression test that asserts this known gap
rather than papering over it.

**This reduces the identifying surface of stored text. It is not anonymisation and must not
be described as such.**

## 4. The encrypted PII map

Sealed spans go into `pii_map`: AES-256-GCM, `LIGHTHOUSE_PII_KEY`, **a fresh IV per seal**.

- **Fresh IV, not a deterministic one.** Deterministic ciphertext would let anyone holding
  the table observe that two conversations name the same person, which is the exact
  inference the encryption exists to prevent. Cross-conversation matching is done
  deliberately elsewhere, with a keyed HMAC, under a different key, at a different layer.
- **GCM, not CBC.** Tampering yields a decryption failure rather than different plaintext. A
  console that could be made to display an attacker-chosen name by flipping bits in a row
  would be worse than one that shows nothing.
- **There is deliberately no `decrypt()` convenience function.** `unseal()` demands a
  counsellor id and a 20-character reason, and returns an audit record alongside the
  plaintext. Making the easy call impossible is a design choice: a helper that "just
  decrypts" gets called from somewhere that forgets to log.

**A database dump without the key yields redacted transcripts and nothing else.** That is
the entire argument for encrypting the map, and it means that in any real deployment the key
belongs in a separate secret store from `DATABASE_URL`. Holding both is equivalent to
holding plaintext. The demo does not achieve that separation and says so in `docs/deploy.md`
rather than pretending otherwise.

## 5. Tiered disclosure

Three levels, with escalating cost:

| Level | Shows | Costs |
|---|---|---|
| `card` | tier, reasons, redacted quotes, timeline | nothing, but it is logged |
| `transcript` | the full redacted conversation | a logged reason, 10 characters |
| `identity` | unsealed names, places, contacts | an explicit escalation **plus** a logged reason, 20 characters |

**Every level is reachable.** A counsellor who needs a name can always get one, and a
safeguarding tool that could not do that would be useless in the moment it mattered. What
changes is the friction and the record. This is not a lock, it is a ratchet: each step is
deliberate and leaves a trace the student can read.

**A T4 tier is not consent to de-anonymise.** Identity requires an explicit human escalation
on top of the tier, kept separate in the request shape. A tier is a machine judgement;
escalation is a person's.

The reason thresholds live in one table (`REASON_CHARS` in `config.ts`) because they had
drifted across four files, each carrying its own copy of the same policy. Four copies of a
number that expresses one policy is four chances for the UI to promise one thing and the
server to enforce another. The ordering is the argument:

```
transcript 10  <  override 10  <  unseal 20  <  break-glass 40
```

Reading a conversation is routine and costs a sentence. Lifting a child's anonymity costs
more. Overruling the safety gate costs most, because a safeguarding lead reads that one
weeks later with no memory of the case and has to be able to tell whether the call was
reasonable.

## 6. The audit log, and the student's copy of it

`counsellor_access` is append-only. Six actions are recorded:

`viewed_card`, `viewed_transcript`, `unsealed_pii`, `overrode_tier`, `broke_glass`,
`reviewed_break_glass`.

**A reason is mandatory on the actions that need one, enforced in the writer.** Not at the
call sites: a check at each call site is the check that is missing from the seventh one.

Three properties make the log worth having:

- **It outlives what it describes.** The audit tables key on `case_id text` with no foreign
  key. They previously cascaded from `conversations`, which meant the retention job deleting
  a conversation also deleted every record of who had opened it. An audit log a routine
  cleanup job can erase is not an audit log.
- **The actor's email is denormalised into every row** at write time. A record whose meaning
  depends on a joinable mutable row can be rewritten by editing that row, and "who was this"
  has to stay answerable after the account is gone.
- **It cannot be deleted.** The store interface exposes no delete for any audit table, so
  the retention job has nothing to call. A test asserts that.

### The student reads the same rows

`/c/[caseId]` renders the same access records the counsellor's page renders, in plain
English, with no counsellor-only view of them. The line on the counsellor's screen reads
*"Shown to you because it is shown to the student."*

That page took four days longer than it should have. §11 of `context.md` promised "an audit
log visible to the student" from day 1, the counsellor's console printed that sentence over
it, and no student could reach it. The user caught it, not a test.

Ordering matters more than it looks. Rows carry a `seq bigserial` alongside their timestamp,
because two actions in the same millisecond are ordinary (opening a case writes
`viewed_card`, acting on it writes another in the same tick) and ordering by `(at, id)`
sorted the tie by random UUID. A student reading "who opened my case" would have seen the
effect before the cause.

## 7. Retention

Non-escalated conversations are deleted after **30 days**, and the student is told that
number up front, so the constant and the consent copy have to match.

**Deletion means content, not existence.** Turns and the encrypted PII map are erased. The
conversation row survives as a tombstone carrying the case id and the deletion date, and the
access log is untouched.

Two different promises are involved and only the first was made. *What you wrote will be
gone* is the commitment. *There will be no trace anything happened* is not, and cannot be,
because a counsellor who read a case stays accountable afterwards.

Verified against real Postgres rather than the memory store:

```
before: {"turns":1,"pii":1,"audit":1}
after:  {"turns":0,"pii":0,"audit":1,"tombstone":{"content_deleted_at":"..."}}
```

Three exemptions, **all reported by name**, because a job that silently skips records is
indistinguishable from a broken one:

| Exemption | Why |
|---|---|
| `escalated` | the case reached a counsellor and the school has a duty of care record |
| `explicit_hold` | someone wrote down a reason to keep it |
| `unreviewed_break_glass` | a lead must be able to read the case a colleague closed against the gate's judgement; deleting it first erases the evidence for the only check that makes break-glass safe |

`GET /api/retention` is a dry run, `POST` deletes, and both refuse without `CRON_SECRET`,
returning 503 when it is unset rather than running unauthenticated.

**One production detail worth keeping.** Vercel Cron can only issue GET, and a bare GET is
the dry run, so the scheduled job is configured as `/api/retention?apply=1`. Without that
parameter it would run every night, log plausible output, and delete nothing: a retention
promise that silently does not run.

## 8. Break-glass

The one path that overrules the gate. Its existence is what makes the floor credible the
rest of the time: a gate tuned to miss nothing will eventually floor a song lyric or a drama
script, and a counsellor with four false T4s and no way out learns to distrust the tier.

- **A separate table from overrides**, not a flag on one. It is a different claim ("the gate
  is wrong about this case" against "I disagree about the urgency") and it has to be
  countable on its own.
- **Refused where there is no floor, and refused at or above the floor.** An override covers
  both, at a tenth of the ceremony.
- **A 40-character reason**, four times the override threshold.
- **Review is after the fact, never before.** A two-person rule sounds stronger and is
  weaker: gate the button on finding a lead, and a counsellor at 7pm on a Friday closes the
  case with a vague override reason instead, and the real decision goes unrecorded. Never
  block the urgent path; count what happens on it. Every row lands unreviewed and the queue
  shows the count.
- **A lead cannot review their own.** A second pair of eyes belonging to the same person is
  not one.
- **It does not un-show the crisis resources.** Those rendered when the gate fired.
- **An unreviewed break-glass blocks retention**, per the table above.

## 9. Counsellor authentication

Net-new for this project. It is the layer that makes every sentence above meaningful: a
tiered disclosure model with no authentication is a suggestion.

**Opaque random session tokens, never JWTs.** A JWT stays valid until it expires and there
is no way to take it back. This system needs the opposite: a counsellor who leaves must lose
access *now*, and what they had access to is children's disclosures. So a token is 32 random
bytes carrying no claims, every request resolves it against the store, and the counsellor
row is re-read each time. That is what makes disabling an account bite immediately rather
than in twelve hours. The cost is a database read per request, which at a school's traffic
is not a cost.

**The store holds `sha256(token)`, never the token.** A stolen database yields no usable
sessions. sha256 rather than scrypt is correct here and not a shortcut: the token is CSPRNG
output, so there is no dictionary to attack. Stretching is for secrets humans chose.

**scrypt for passwords**, from `node:crypto`. bcrypt and argon2 are native addons, and a
native binary that works locally and 500s on serverless is a bad trade for one week of build
time. The stored format `scrypt$N$r$p$salt$hash` carries its own parameters, so the cost can
be raised later; sign-in rehashes on the one occasion the plaintext exists.

**One error message for every sign-in failure.** Unknown email, wrong password and disabled
account are indistinguishable, and `active` is checked *after* the password so a disabled
account does not answer faster. Which staff use this system is a fact about a school's
safeguarding arrangements, not a UX detail.

**Minimum password length is 12, and it is deliberately the only rule.** Composition
requirements measurably push people toward `Password1!` and toward a sticky note beside a
screen displaying children's disclosures. Length is the property that correlates with
strength.

**Accounts are created from a CLI** (`npm run counsellor:add`), never a web form. The set of
adults who may read children's disclosures is a decision a school makes in a room. There is
no self-service sign-up and no password reset.

**`requireCounsellor()` is called at the top of every protected page and route handler.** Not
in a layout, because layouts do not re-render on navigation between their children, and not
in middleware, because Next's own guidance is that middleware is an optimistic redirect and
not the authorisation. It returns the principal the handler needs, so forgetting to call it
does not compile.

## 10. Clustering without names

Cross-conversation pattern detection and anonymity look contradictory. To know that four
students named the same boy, you appear to need the boy's name. You do not.

Store `HMAC-SHA256(key, normalised_name)`. "Kai", "kai" and "Kai!" fold to one token, two
conversations naming him produce the *same* token, and the database holds no name at all. In
the seeded cluster all four reports resolved to `per_5034b50e06bc` and `pla_088b5679f48c`;
the planted decoy resolved to different tokens for both and joined nothing.

A counsellor sees *"the same person"*. Nobody, including us, learns who.

**HMAC rather than a bare hash**, because there are only a few thousand common first names
and a plain SHA-256 digest of one is enumerable in a second. The key is the whole protection,
and it is a different key from the PII map's, at a different layer, for a different purpose.

## 11. Threat model

Who we are defending against, and how far each defence goes.

| Adversary | Defence | Honest limit |
|---|---|---|
| **A curious adult with database read access** | text is redacted; identifying spans are sealed under a key that is not in the database | if they hold both the dump and `LIGHTHOUSE_PII_KEY`, they hold plaintext; this is why the key belongs in a separate store |
| **A stolen database backup** | sessions are stored hashed, passwords are scrypt, PII is AES-256-GCM | lowercase names that redaction missed are in the clear in `turns` |
| **A counsellor exceeding their remit** | every read is logged, every log entry is visible to the student, reasons are mandatory and enforced in the writer | detection, not prevention; this is deliberate, since a safeguarding tool that blocks a counsellor in an emergency is worse |
| **A former counsellor** | opaque tokens resolved per request against a re-read account row; disabling bites immediately | no automatic offboarding; someone has to run the CLI |
| **A student guessing another student's case id** | server-minted random case ids | a case id is a bearer capability; anyone who obtains one can read that receipt |
| **Someone tampering with stored PII to mislead a counsellor** | GCM authentication tags | none in the audit tables themselves; they are append-only by interface, not cryptographically |
| **Online password guessing** | scrypt at N=16384 makes each attempt slow | **no rate limiting on sign-in.** Slow is not stopped |
| **Traffic analysis / an observer on the school network** | HTTPS, `noindex`, `Cache-Control: no-store` on console routes | that a student used the site at all is not hidden |

## 12. What this does not achieve

Stated here so a reader does not have to discover it.

- **Redaction is not anonymisation.** Without extracted entities, a lowercase name survives.
  On the live path that is the normal case, because entity extraction is an offline batch
  step over a finished conversation.
- **Level 3 is designed, tested, and unwired.** `seal.ts:unseal()` has no caller. Identity
  disclosure is reachable in the model and unreachable in the product. The console does not
  claim otherwise, which is the minimum honest position and not a fix.
- **No password reset and no self-service sign-up.** A lost password means a new account.
  Deliberate for now, since an email reset flow is another path into the set of adults who
  can read children's disclosures, but it is a gap and not a feature.
- **No rate limiting on sign-in.**
- **The demo holds the PII key beside the database URL.** In a real deployment it must not.
- **The in-memory store is not safe for production.** On serverless each instance has its
  own module scope, so an override written by one request can be invisible to the next. The
  app says so loudly when `DATABASE_URL` is unset.
- **There is no data subject deletion request flow.** Retention is time-based. A student who
  wants their case erased today has no button for it.
- **Nothing here has had a legal review.** The design draws on the shape of safeguarding
  practice, not on advice from anyone qualified to give it. Any real deployment needs a DPIA
  and a school's own safeguarding lead in the room.
