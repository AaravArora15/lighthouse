# CLAUDE.md — Lighthouse

## Read this first, every session

1. Read `docs/context.md` — durable facts, locked decisions, taxonomy, schemas, thresholds.
2. Read `docs/plan.md` — the day-by-day checklist and where we actually are.
3. Skim the tail of `docs/log.md` — what the last session built, what broke, the next action.

## Write this last, every session

Append a dated entry to `docs/log.md` before you finish. It must contain:
- what was built
- **the numbers produced** (macro-F1, recall@budget, Brier, whatever the day's gate was)
- what broke
- the single next action

A session that produces no log entry did not happen.

## Rules that are not up for discussion

- **The classifier decides, the LLM only explains.** A fine-tuned model produces the risk tier. The LLM writes summary and rationale prose and nothing else. If the Anthropic API is down, triage still works. Do not add a code path where an LLM chooses a tier.
- **The deterministic safety gate runs before the conversational model**, and emits floors and ceilings, never a final decision. No model output may lower a gate floor.
- **Crisis resources are unconditional.** On a T4 gate hit, real crisis line numbers render to the student before any model output, and still render when the LLM call fails, times out, or refuses.
- **This is a listening and routing tool, not therapy.** Never write copy that claims clinical capability.
- **All demo conversations are synthetic.** Say so in the README and on the submission page.
- Never commit real conversation data, `.env`, model checkpoints, or dataset archives.

## Conventions

- Tunable constants live in exactly one file per runtime: `ml/lighthouse/config.py` (Python), `web/src/lib/config.ts` (TS). Do not scatter magic numbers.
- The taxonomy lives in `ml/lighthouse/taxonomy.py` and is mirrored in `web/src/lib/taxonomy.ts`. Change both or neither.
- Behaviour tests must run offline: no API key, no database, no network.
- Don't use em-dashes in prose written for the user.

## Layout

```
docs/          context, plan, log, ideas, and the day 8-10 submission docs
ml/            Python: taxonomy, safety gate, training, calibration, eval
web/           Next.js: student chat, counsellor console (day 5+)
data/          gitignored: raw datasets and generated splits
```
