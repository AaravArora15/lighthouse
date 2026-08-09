"""Cross-conversation pattern detection: the thing no single counsellor can do.

    python -m lighthouse.cluster.patterns            # print clusters
    python -m lighthouse.cluster.patterns --write    # fixtures/pattern_alerts.json

Four students, four separate anonymous conversations, none of whom know each other, each
describing something that on its own reads as ordinary playground nastiness. A counsellor
working the queue sees four unrelated T2s over nine days. This module sees one pattern.

That is the claim, and it is the novel part of the project. Everything else here is triage
done carefully; this is a capability a school does not currently have.

## How the linking works, and why it is not embeddings

Reuse note in `context.md` section 12 called for BM25 + char-n-gram + a time window rather
than embeddings, and that is what this is. Three signals combine:

1. **Shared entity pseudonyms** — the load-bearing one. Two reports naming the same
   HMAC token for a person or a place is strong evidence they concern the same situation,
   and it is exact rather than fuzzy, so it can be *explained* to a counsellor.
2. **Lexical similarity** — BM25 over word tokens plus character-trigram cosine. Catches
   two students describing the same event with no name in common ("the middle staircase" /
   "the stairs by the science block").
3. **A time window** — links only form inside `PATTERN_WINDOW_DAYS`. A report from last
   term and one from today are not a pattern, they are a history, and conflating them
   would surface stale clusters forever.

Embeddings would score better on signal 2 and would cost the ability to say *why* two
cases linked. A counsellor being asked to act on a cluster needs "both name the same person
and the same corridor", not "cosine 0.83".

## What an alert is, and what it is not

**A prompt to look, not a finding.** The output says four conversations may concern one
situation; it does not say who did what, and it never merges the cases or changes a tier.
Tiers stay exactly where the classifier and gate put them. A false link costs a counsellor
thirty seconds; a missed pattern costs a child a term, so the thresholds lean toward
surfacing.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Sequence

from lighthouse import config
from lighthouse.cluster.entities import load_entities
from lighthouse.data.synthetic import load

OUTPUT = config.FIXTURES_DIR / "pattern_alerts.json"

_WORD = re.compile(r"[a-z']+")

#: Words that carry no discriminative signal in this corpus. Every conversation is a
#: student describing school, so "school", "class" and "said" link everything to
#: everything. Kept short deliberately: an aggressive stoplist would strip the very
#: vocabulary ("stairwell", "corridor") the lexical signal depends on.
_STOP = frozenset(
    """i me my myself you your he him his she her they them their it its this that
    a an the and or but if so then than of to in on at for with from by is am are was
    were be been being do does did doing have has had having not no yes just really
    about like get got go going went come came know knew think thought say said says
    tell told want wanted because when what who how why school class lesson day today
    now still bit lot""".split()
)


def _tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 2]


def _char_ngrams(text: str, n: int = 3) -> Counter:
    squashed = re.sub(r"\s+", " ", text.lower())
    return Counter(squashed[i : i + n] for i in range(max(0, len(squashed) - n + 1)))


def _cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    shared = set(a) & set(b)
    if not shared:
        return 0.0
    dot = sum(a[k] * b[k] for k in shared)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


class Bm25:
    """Minimal BM25 over the corpus. ~40 lines beats a dependency for 85 documents."""

    def __init__(self, docs: dict[str, list[str]], k1: float = 1.5, b: float = 0.75):
        self.docs = docs
        self.k1, self.b = k1, b
        self.freqs = {cid: Counter(toks) for cid, toks in docs.items()}
        self.lengths = {cid: len(toks) for cid, toks in docs.items()}
        self.avg_len = (sum(self.lengths.values()) / len(docs)) if docs else 0.0
        n = len(docs)
        df = Counter()
        for toks in docs.values():
            df.update(set(toks))
        # +0.5/+1 smoothing keeps the idf of a term appearing in every document at a small
        # positive value rather than negative, which would make common words *repel*.
        self.idf = {
            term: math.log(1 + (n - count + 0.5) / (count + 0.5)) for term, count in df.items()
        }

    def score(self, query_id: str, doc_id: str) -> float:
        freqs, length = self.freqs[doc_id], self.lengths[doc_id]
        if not length:
            return 0.0
        total = 0.0
        for term in set(self.docs[query_id]):
            f = freqs.get(term, 0)
            if not f:
                continue
            denom = f + self.k1 * (1 - self.b + self.b * length / (self.avg_len or 1))
            total += self.idf.get(term, 0.0) * f * (self.k1 + 1) / denom
        return total


def _jaccard(a: Sequence[str], b: Sequence[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


@dataclass
class Link:
    a: str
    b: str
    entityOverlap: float
    lexical: float
    daysApart: float
    sharedPeople: list[str]
    sharedPlaces: list[str]
    reason: str


@dataclass
class PatternAlert:
    clusterId: str
    caseIds: list[str]
    size: int
    windowDays: float
    sharedPeople: list[str]
    sharedPlaces: list[str]
    headline: str
    links: list[dict] = field(default_factory=list)
    tiers: list[str] = field(default_factory=list)


def build_alerts(cards: list[dict]) -> list[PatternAlert]:
    """Link, agglomerate, and describe. `cards` supplies tiers and timestamps."""
    entities = load_entities()
    conversations = {c.id: c for c in load()}
    by_id = {c["caseId"]: c for c in cards}

    ids = [c["caseId"] for c in cards if c["caseId"] in conversations]
    docs = {cid: _tokens(" ".join(conversations[cid].student_turns)) for cid in ids}
    grams = {cid: _char_ngrams(" ".join(conversations[cid].student_turns)) for cid in ids}
    bm25 = Bm25(docs)

    def started(cid: str) -> datetime:
        return datetime.fromisoformat(by_id[cid]["startedAt"])

    # Normalise BM25 to [0,1] against the best off-diagonal score, so the threshold is
    # readable. Raw BM25 has no fixed range and would make the constant meaningless.
    raw = {
        (a, b): bm25.score(a, b)
        for i, a in enumerate(ids)
        for b in ids[i + 1 :]
    }
    best = max(raw.values(), default=0.0) or 1.0

    links: list[Link] = []
    for (a, b), score in raw.items():
        days = abs((started(a) - started(b)).total_seconds()) / 86400.0
        if days > config.PATTERN_WINDOW_DAYS:
            continue

        ea, eb = entities.get(a), entities.get(b)
        people = sorted(set(ea.people) & set(eb.people)) if ea and eb else []
        places = sorted(set(ea.places) & set(eb.places)) if ea and eb else []
        entity_overlap = max(
            _jaccard(ea.people, eb.people) if ea and eb else 0.0,
            _jaccard(ea.places, eb.places) if ea and eb else 0.0,
        )
        lexical = 0.5 * (score / best) + 0.5 * _cosine(grams[a], grams[b])

        # A shared entity is the only thing that links on its own. Lexical similarity
        # alone is not enough and must not be: every conversation in this corpus is a
        # teenager describing school in the same register, so a purely lexical linker
        # joins the whole corpus into one meaningless cluster. Text similarity acts as a
        # corroborator, never as the sole evidence.
        if people or places:
            reason_parts = []
            if people:
                reason_parts.append(f"{len(people)} shared person")
            if places:
                reason_parts.append(f"{len(places)} shared location")
            reason = " and ".join(reason_parts) + f", {days:.0f} days apart"
        elif entity_overlap >= config.PATTERN_ENTITY_THRESHOLD and lexical >= config.PATTERN_LEXICAL_THRESHOLD:
            reason = f"similar accounts, {days:.0f} days apart"
        else:
            continue

        links.append(
            Link(a, b, round(entity_overlap, 3), round(lexical, 3), round(days, 1),
                 people, places, reason)
        )

    # Single-linkage agglomeration via connected components. Single linkage is the right
    # choice for "these may be the same situation": A-B and B-C sharing a person makes
    # A-C worth showing even where A and C name nothing in common, which is precisely the
    # case a counsellor cannot spot by hand.
    parent = {cid: cid for cid in ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for link in links:
        ra, rb = find(link.a), find(link.b)
        if ra != rb:
            parent[ra] = rb

    groups: dict[str, list[str]] = {}
    for cid in ids:
        groups.setdefault(find(cid), []).append(cid)

    alerts: list[PatternAlert] = []
    for members in groups.values():
        if len(members) < config.PATTERN_MIN_CLUSTER:
            continue
        members = sorted(members)
        member_links = [l for l in links if l.a in members and l.b in members]
        people = sorted({p for l in member_links for p in l.sharedPeople})
        places = sorted({p for l in member_links for p in l.sharedPlaces})
        span = max(
            (abs((started(a) - started(b)).total_seconds()) / 86400.0
             for a in members for b in members),
            default=0.0,
        )

        bits = [f"{len(members)} separate reports"]
        if places:
            bits.append("naming the same location")
        if people:
            bits.append("naming the same person")
        headline = ", ".join(bits) + f", within {span:.0f} days"

        alerts.append(
            PatternAlert(
                clusterId="cluster-" + members[0],
                caseIds=members,
                size=len(members),
                windowDays=round(span, 1),
                sharedPeople=people,
                sharedPlaces=places,
                headline=headline,
                links=[asdict(l) for l in member_links],
                tiers=[by_id[m]["tier"] for m in members],
            )
        )

    return sorted(alerts, key=lambda a: (-a.size, a.clusterId))


def _cards() -> list[dict]:
    path = config.FIXTURES_DIR / "escalation_cards.json"
    if not path.exists():
        raise SystemExit("run `python -m lighthouse.model.card --write` first")
    return json.loads(path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    alerts = build_alerts(_cards())

    if args.write:
        OUTPUT.write_text(
            json.dumps(
                {
                    "note": (
                        "Generated by `python -m lighthouse.cluster.patterns --write`. "
                        "Entity values are keyed HMAC pseudonyms, never names. An alert is "
                        "a prompt to look, not a finding: it never changes a tier."
                    ),
                    "windowDays": config.PATTERN_WINDOW_DAYS,
                    "minClusterSize": config.PATTERN_MIN_CLUSTER,
                    "alerts": [asdict(a) for a in alerts],
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        print(f"wrote {OUTPUT.relative_to(config.REPO_ROOT)}")

    print(f"\n{len(alerts)} pattern alert(s), window {config.PATTERN_WINDOW_DAYS}d, "
          f"min size {config.PATTERN_MIN_CLUSTER}\n")
    for alert in alerts:
        print(f"  {alert.clusterId}: {alert.headline}")
        print(f"    cases: {', '.join(alert.caseIds)}  tiers: {', '.join(alert.tiers)}")
        for link in alert.links:
            print(f"      {link['a']} ~ {link['b']}: {link['reason']}")


if __name__ == "__main__":
    main()
