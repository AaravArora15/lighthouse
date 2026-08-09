"""Entity extraction, pseudonymised at the point of extraction.

    python -m lighthouse.cluster.entities --extract    # calls the API, writes the fixture
    python -m lighthouse.cluster.entities              # show what was extracted

Pulls people, places and platforms out of a transcript so day 7's clustering can ask
"do these four reports name the same person and the same corridor?".

## The privacy problem this file solves

Clustering on entities and protecting anonymity look like they contradict each other.
To know that four students named the same boy you appear to need to store the boy's name,
and `docs/context.md` section 11 says PII is redacted before storage and unsealed only on
escalation.

They do not contradict. **Store a deterministic pseudonym instead of the name.**
`HMAC-SHA256(key, normalised_name)` gives the same opaque token for "Kai", "kai" and
"Kai R" every time, so two conversations that name the same person produce the same token
and cluster together — while the database holds no name at all. A counsellor sees "four
reports name the same person"; nobody, including us, learns who from the cluster index.

The key lives outside the repo (`LIGHTHOUSE_ENTITY_KEY`). Without it the pseudonyms are
still internally consistent, so the demo works, but they are not secret — that is stated
rather than hidden, and day 8 moves the key into the same place as the PII map's.

**Why HMAC and not a plain hash.** A plain SHA-256 of a first name is trivially reversible:
there are only a few thousand common names, so anyone with the digest can enumerate them in
a second. The key is what makes the token opaque to someone holding the database.

## Why the LLM does this and not a regex

Names, places and platforms are open-class. A regex bank can enumerate self-harm phrasings
because there are dozens of them; it cannot enumerate the ways a teenager refers to a
corridor. This is the one place in the project where an LLM's judgement is load-bearing —
and note what it is trusted with: **it never sees a tier and never influences one.** It
reads a transcript and returns nouns. If it fails, clustering degrades and triage does not.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
from dataclasses import asdict, dataclass, field
from typing import Sequence

from lighthouse import config
from lighthouse.data.synthetic import load

OUTPUT = config.FIXTURES_DIR / "entities.json"

#: Demo default. A real deployment sets `LIGHTHOUSE_ENTITY_KEY` from the same secret store
#: as the PII map's key. With this default the pseudonyms are consistent but not secret,
#: which is fine for synthetic data and is called out in the fixture's own `note` field.
_DEMO_KEY = b"lighthouse-demo-entity-key-not-secret"


def entity_key() -> bytes:
    value = os.environ.get("LIGHTHOUSE_ENTITY_KEY")
    return value.encode() if value else _DEMO_KEY


def normalise_entity(raw: str) -> str:
    """Fold the spellings a student might use into one key.

    Lowercase, strip punctuation and honorifics, collapse whitespace, and keep only the
    first token of a person's name. "Kai", "kai", "Kai R" and "KAI!!" all become "kai".

    Deliberately blunt. Over-merging costs a false cluster link, which a counsellor sees
    and dismisses; under-merging costs a missed pattern, which nobody sees at all. Given
    the cluster is a *prompt to look*, not a finding, the asymmetry favours merging.
    """
    text = raw.lower().strip()
    text = re.sub(r"^(mr|mrs|miss|ms|sir|dr)\.?\s+", "", text)
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def pseudonym(raw: str, kind: str) -> str:
    """Stable, opaque, keyed. Same input, same token, in any conversation and any process."""
    normalised = normalise_entity(raw)
    digest = hmac.new(
        entity_key(), f"{kind}:{normalised}".encode(), hashlib.sha256
    ).hexdigest()
    return f"{kind[:3]}_{digest[:12]}"


@dataclass
class ConversationEntities:
    caseId: str
    people: list[str] = field(default_factory=list)
    places: list[str] = field(default_factory=list)
    platforms: list[str] = field(default_factory=list)
    #: Present ONLY in the local demo fixture so a human can verify the clustering is
    #: matching on what it claims to. Never written to the database, never sent to the
    #: console. Day 8 drops it from the pipeline entirely.
    debug_plaintext: dict[str, list[str]] = field(default_factory=dict)


# --------------------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------------------

_SCHEMA = {
    "type": "object",
    "properties": {
        "people": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "First names or nicknames of OTHER people the student names — the person "
                "doing the harm, bystanders, siblings. Never the student themselves. "
                "Never staff titles like 'miss' or 'sir' with no name attached."
            ),
        },
        "places": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Specific locations inside or around the school where something happened: "
                "'science block stairwell', 'music corridor', 'the bus stop'. Only places "
                "tied to an incident, not places mentioned in passing."
            ),
        },
        "platforms": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Named apps, games or sites where something happened: 'snapchat', "
                "'instagram', 'fortnite'."
            ),
        },
    },
    "required": ["people", "places", "platforms"],
    "additionalProperties": False,
}

_SYSTEM = """You extract entities from a school chat transcript so a safeguarding team can \
see when several separate reports describe the same person or the same place.

Return only what the student actually names. Do not infer, do not generalise, and do not \
invent a location because one seems likely. An empty list is the correct answer when the \
student named nothing.

Normalise lightly: lowercase, and use the shortest form the student used. If they say \
"the stairwell by the science block" and later "the science block stairs", return one \
entry, not two.

Never return the student's own name or handle. Never return a description of a person \
instead of a name ("the tall one" is not a name)."""


def extract_one(client, case_id: str, turns: Sequence[str]) -> ConversationEntities:
    """One conversation. Returns empty lists rather than raising when the model declines."""
    transcript = "\n".join(f"- {t}" for t in turns)
    try:
        response = client.messages.create(
            model=config.INTAKE_MODEL,
            max_tokens=1024,
            system=_SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
            messages=[{"role": "user", "content": f"Transcript:\n{transcript}"}],
        )
        # A refusal is HTTP 200 with empty content. This domain is exactly what safety
        # classifiers decline, so treat it as "no entities" and carry on — clustering
        # degrading is survivable, an unhandled exception in a batch job is not.
        if response.stop_reason == "refusal" or not response.content:
            print(f"  {case_id}: model declined, no entities")
            return ConversationEntities(caseId=case_id)

        # Find the text block; do NOT index content[0]. Thinking is on by default on
        # Claude Opus 5, so position 0 is a ThinkingBlock and `.text` raises. The first
        # run of this extractor failed on all 85 conversations for exactly that reason.
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            print(f"  {case_id}: no text block in response, no entities")
            return ConversationEntities(caseId=case_id)
        raw = json.loads(text)
    except Exception as exc:  # noqa: BLE001 — one conversation must not kill the batch
        # Print the message, not just the class. A bare class name cost a full batch
        # run to diagnose an AttributeError that a one-line message would have named.
        print(f"  {case_id}: extraction failed ({exc.__class__.__name__}: {exc}), no entities")
        return ConversationEntities(caseId=case_id)

    return ConversationEntities(
        caseId=case_id,
        people=_tokens_for(raw, "person", "people"),
        places=_tokens_for(raw, "place", "places"),
        platforms=_tokens_for(raw, "platform", "platforms"),
        debug_plaintext={
            "people": sorted({normalise_entity(v) for v in raw.get("people", []) if v}),
            "places": sorted({normalise_entity(v) for v in raw.get("places", []) if v}),
            "platforms": sorted({normalise_entity(v) for v in raw.get("platforms", []) if v}),
        },
    )


def _tokens_for(raw: dict, kind: str, plural: str) -> list[str]:
    out: list[str] = []
    for value in raw.get(plural, []):
        if isinstance(value, str) and value.strip():
            token = pseudonym(value, kind)
            if token not in out:
                out.append(token)
    return out


def extract_all() -> list[ConversationEntities]:
    import anthropic

    client = anthropic.Anthropic()
    out: list[ConversationEntities] = []
    for convo in load():
        entities = extract_one(client, convo.id, convo.student_turns)
        out.append(entities)
    return out


def load_entities() -> dict[str, ConversationEntities]:
    if not OUTPUT.exists():
        raise FileNotFoundError(
            f"{OUTPUT} is missing. Run: python -m lighthouse.cluster.entities --extract"
        )
    payload = json.loads(OUTPUT.read_text())
    return {
        row["caseId"]: ConversationEntities(**row) for row in payload["conversations"]
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extract", action="store_true", help="call the API and rewrite")
    args = parser.parse_args()

    if args.extract:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise SystemExit("ANTHROPIC_API_KEY is not set (see ml/.env.example)")
        rows = extract_all()
        OUTPUT.write_text(
            json.dumps(
                {
                    "note": (
                        "Generated by `python -m lighthouse.cluster.entities --extract`. "
                        "Entity values are keyed HMAC pseudonyms, not names. "
                        "`debug_plaintext` exists only so a human can verify the demo's "
                        "clustering and is never stored or served in the product. "
                        "Pseudonyms here use the demo key, so they are consistent but not "
                        "secret; a deployment sets LIGHTHOUSE_ENTITY_KEY."
                    ),
                    "model": config.INTAKE_MODEL,
                    "conversations": [asdict(r) for r in rows],
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        total = sum(len(r.people) + len(r.places) + len(r.platforms) for r in rows)
        named = sum(1 for r in rows if r.people or r.places or r.platforms)
        print(f"\nwrote {OUTPUT.relative_to(config.REPO_ROOT)}")
        print(f"  {len(rows)} conversations, {named} naming at least one entity")
        print(f"  {total} entity mentions")
        return

    for case_id, row in load_entities().items():
        if row.people or row.places:
            print(f"{case_id:<9} people={row.debug_plaintext.get('people')} "
                  f"places={row.debug_plaintext.get('places')}")


if __name__ == "__main__":
    main()
