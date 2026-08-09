"""Cross-conversation clustering, held to precision as well as recall.

The seeded corpus exists to make both directions testable: four conversations that must
link (same person, same place, nine days) and one decoy that must not (same school, same
fortnight, similar vocabulary, different person and place).

Precision is the harder half and the one that decides whether the panel gets read. A
clustering layer that joins everything is indistinguishable from no clustering layer.
"""

from __future__ import annotations

import json

import pytest

from lighthouse import config
from lighthouse.cluster.entities import normalise_entity, pseudonym
from lighthouse.cluster.patterns import build_alerts

CLUSTER = {"syn-081", "syn-082", "syn-083", "syn-084"}
DECOY = "syn-085"


@pytest.fixture(scope="module")
def alerts():
    path = config.FIXTURES_DIR / "escalation_cards.json"
    if not path.exists():
        pytest.skip("run `python -m lighthouse.model.card --write` first")
    try:
        return build_alerts(json.loads(path.read_text()))
    except FileNotFoundError:
        pytest.skip("run `python -m lighthouse.cluster.entities --extract` first")


# ---------------------------------------------------------------------------------------
# The day 7 gate
# ---------------------------------------------------------------------------------------


def test_the_stairwell_cluster_fires(alerts) -> None:
    """The plan's acceptance criterion, verbatim: four reports, same location, nine days."""
    match = [a for a in alerts if CLUSTER <= set(a.caseIds)]
    assert match, f"the seeded cluster did not fire. alerts: {[a.caseIds for a in alerts]}"
    alert = match[0]
    assert alert.size >= 4
    assert alert.sharedPeople, "linked without a shared person"
    assert alert.sharedPlaces, "linked without a shared location"
    assert 8 <= alert.windowDays <= 10, f"expected a ~9 day window, got {alert.windowDays}"


def test_the_decoy_stays_out(alerts) -> None:
    """Precision. syn-085 is the same school in the same fortnight with the same register,
    and a different person in a different place. If it joins, the linker is matching on
    style and the alert is worthless."""
    for alert in alerts:
        assert DECOY not in alert.caseIds, (
            f"the decoy joined {alert.clusterId}: clustering is matching on vocabulary "
            "rather than on entities"
        )


def test_the_cluster_rescues_a_case_the_classifier_dismissed(alerts) -> None:
    """The argument for this whole layer.

    syn-081 is a student describing being pushed down stairs twice in a week, and the
    conversation head scores it T0 — the victim-voice gap from context.md section 10, doing
    exactly what day 4 said it would. The cluster surfaces it because two other students
    named the same person and place. If this stops being true the demo still works, but
    the reason to build clustering has quietly gone away.
    """
    cards = {
        c["caseId"]: c
        for c in json.loads((config.FIXTURES_DIR / "escalation_cards.json").read_text())
    }
    clustered = {cid for a in alerts for cid in a.caseIds}
    rescued = [
        cid for cid in clustered if cards[cid]["tier"] in ("T0", "T1")
    ]
    assert rescued, (
        "no clustered case was below the queue threshold on its own — the pattern layer "
        "is currently only re-finding cases the queue already surfaces"
    )


def test_no_alert_is_smaller_than_the_minimum(alerts) -> None:
    for alert in alerts:
        assert alert.size >= config.PATTERN_MIN_CLUSTER


def test_every_link_stays_inside_the_window(alerts) -> None:
    for alert in alerts:
        for link in alert.links:
            assert link["daysApart"] <= config.PATTERN_WINDOW_DAYS


def test_the_whole_corpus_does_not_collapse_into_one_cluster(alerts) -> None:
    """The failure mode of a purely lexical linker. Every conversation here is a teenager
    describing school, so text similarity alone merges all 85."""
    for alert in alerts:
        assert alert.size < 20, (
            f"{alert.clusterId} has {alert.size} members — the linker is almost certainly "
            "matching on register rather than on entities"
        )


def test_every_link_carries_a_counsellor_readable_reason(alerts) -> None:
    for alert in alerts:
        assert alert.headline
        for link in alert.links:
            assert link["reason"], "a link with no explanation cannot be acted on"


# ---------------------------------------------------------------------------------------
# Pseudonymisation
# ---------------------------------------------------------------------------------------


def test_pseudonyms_are_stable_across_spellings() -> None:
    """The property clustering depends on: two students writing the same name differently
    must produce the same token, or the pattern never forms."""
    base = pseudonym("Kai", "person")
    for variant in ["kai", "KAI", " Kai ", "Kai!", "kai."]:
        assert pseudonym(variant, "person") == base, f"{variant!r} did not fold to {base}"


def test_pseudonyms_separate_different_entities() -> None:
    assert pseudonym("kai", "person") != pseudonym("jamie", "person")


def test_the_same_string_in_different_kinds_does_not_collide() -> None:
    """A person called "library" and the library are different things and must not link."""
    assert pseudonym("library", "person") != pseudonym("library", "place")


def test_a_pseudonym_does_not_leak_the_name() -> None:
    token = pseudonym("Kai", "person")
    assert "kai" not in token.lower()
    assert len(token) < 24


def test_normalisation_strips_honorifics_and_punctuation() -> None:
    assert normalise_entity("Mr. Smith") == "smith"
    assert normalise_entity("  the  Science   Block  ") == "the science block"


def test_the_committed_entities_hold_no_names_in_the_shipped_fields() -> None:
    """`debug_plaintext` is the demo's verification aid and is explicitly not part of the
    product. Every field the console can read must be opaque."""
    path = config.FIXTURES_DIR / "entities.json"
    if not path.exists():
        pytest.skip("entities fixture not generated")
    payload = json.loads(path.read_text())
    for row in payload["conversations"]:
        for kind in ("people", "places", "platforms"):
            for token in row[kind]:
                assert token[:4] in ("per_", "pla_", "pla", "plat"), token
                assert "_" in token and len(token) <= 20
