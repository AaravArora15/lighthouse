---
title: Lighthouse Scoring Service
emoji: 🪔
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Lighthouse scoring service

The classifier half of Lighthouse, behind one HTTP call. A fine-tuned turn classifier, a
logistic conversation head with isotonic calibration, and a deterministic safety gate,
returning a finished escalation card.

**Every conversation this service was trained and demonstrated on is synthetic.** No real
student ever spoke to it.

This is a listening and routing tool. It does not diagnose, treat, or offer therapy.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Liveness, plus whether the checkpoint is present and loaded |
| `POST /score` | One conversation in, one escalation card out |

```bash
curl -X POST https://<user>-<space>.hf.space/score \
  -H 'Content-Type: application/json' \
  -d '{"caseId":"demo","handle":"anon","startedAt":"2026-01-01T00:00:00Z",
       "turns":[{"role":"student","text":"i have not slept in days and nothing helps"}]}'
```

## What this service cannot do

It cannot decide whether a student sees crisis resources. That already happened, in the
browser, before this service was contacted, from a safety gate that runs in about 123µs
with no network. Nothing returned here can revoke it.

A failure here is not an outage. The caller applies a four-second timeout and keeps its
gate-only card if this does not answer, which is a designed state with its own screen copy.
On free Space hardware the container sleeps after 48 hours and cold-starts in roughly 30
seconds, so the first request of the day timing out is the expected case.

## Note on the first request

The checkpoint is loaded lazily, on first `/score`, so `/health` answers while it is still
loading rather than being killed during a slow start. That first scoring request takes
about ten seconds; every one after it is about 30ms.

Built from the `ml/` half of the Lighthouse repository. This Space is a generated build
output, not the source of truth.
