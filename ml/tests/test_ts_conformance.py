"""The Python half of the two-runtime gate contract.

The gate exists in two languages. `web/src/lib/gate/gate.conformance.test.ts` proves the
TypeScript port reproduces Python's verdicts, but it can only prove that about the
**committed** `fixtures/gate_expectations.json`. If someone edits a Python pattern and does
not re-export, the TS suite keeps passing against a stale snapshot and the two runtimes
drift in silence. That is the gap this file closes.

Together the two files make the contract unfalsifiable by editing one side:

* Edit Python, forget to re-export -> **this file fails** (the snapshot is stale).
* Re-export, forget to mirror in TS -> **the vitest suite fails** (verdicts differ).
* Rename a pattern in Python only    -> **this file fails** (name sets differ).
* Change a MIRRORED constant in one  -> **both fail**.

Offline, like everything else here: two source trees on disk, no node, no network, no key.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from lighthouse import config
from lighthouse.gate.export_expectations import OUTPUT, build
from lighthouse.gate.patterns import PATTERNS, SUPPRESSORS
from lighthouse.taxonomy import GateCategory

WEB_LIB = config.REPO_ROOT / "web" / "src" / "lib"
TS_PATTERNS = WEB_LIB / "gate" / "patterns.ts"
TS_CONFIG = WEB_LIB / "config.ts"
TS_TAXONOMY = WEB_LIB / "taxonomy.ts"

pytestmark = pytest.mark.skipif(
    not TS_PATTERNS.exists(),
    reason="web/ not present; the TS mirror is only required once the web app exists",
)


# ---------------------------------------------------------------------------------------
# The exported snapshot must be current
# ---------------------------------------------------------------------------------------


def test_the_exported_expectations_are_not_stale() -> None:
    """Regenerate from the live gate and diff against what is committed.

    This is the test that makes the whole two-runtime arrangement safe. Without it, a
    pattern edit on the Python side leaves the TS suite passing against a snapshot of a
    gate that no longer exists.
    """
    assert OUTPUT.exists(), (
        f"{OUTPUT.name} is missing. Run: python -m lighthouse.gate.export_expectations"
    )

    committed = json.loads(OUTPUT.read_text())
    current = json.loads(json.dumps(build(), sort_keys=True))

    if committed != current:
        changed = [
            key for key in current if committed.get(key) != current.get(key)
        ]
        pytest.fail(
            "fixtures/gate_expectations.json is out of date with the Python gate "
            f"(sections that differ: {', '.join(changed) or 'unknown'}).\n"
            "The TypeScript conformance suite is therefore checking itself against a "
            "gate that no longer exists.\n"
            "Fix: python -m lighthouse.gate.export_expectations, then run the web suite "
            "(cd web && npm test) and mirror any pattern change into "
            "web/src/lib/gate/patterns.ts."
        )


# ---------------------------------------------------------------------------------------
# The banks must contain the same patterns, by name
# ---------------------------------------------------------------------------------------


#: One `["name", R`chunk` + R`chunk`]` entry. The name is the first string literal; the
#: regex is every backtick-delimited chunk after it, concatenated. `String.raw` means those
#: chunks are literal, so joining them reproduces the Python raw string character for
#: character — which is what makes an exact comparison possible at all.
_TS_ENTRY = re.compile(
    r'"(?P<name>[a-z0-9_]+)",\s*(?P<body>R`[^`]*`(?:\s*\+\s*R`[^`]*`)*)',
    re.DOTALL,
)


#: TS const name per category, for the pattern banks and the suppressor banks.
#: Parsing per const rather than over the whole file is not fussiness: two suppressor
#: names are reused across categories with *different* regexes (`topic_not_disclosure` in
#: the self-harm and suicide banks, `gaming_context` in the threat and weapon banks), so a
#: flat name->regex dict silently drops one of each pair and then compares the wrong two.
_TS_CONSTS: dict[GateCategory, tuple[str, str | None]] = {
    GateCategory.SELF_HARM_INTENT: ("SELF_HARM_INTENT", "SELF_HARM_SUPPRESSORS"),
    GateCategory.SUICIDAL_IDEATION: ("SUICIDAL_IDEATION", "SUICIDE_SUPPRESSORS"),
    GateCategory.ABUSE_DISCLOSURE: ("ABUSE_DISCLOSURE", "ABUSE_SUPPRESSORS"),
    GateCategory.THREAT_OF_VIOLENCE: ("THREAT_OF_VIOLENCE", "THREAT_SUPPRESSORS"),
    GateCategory.WEAPON_MENTION: ("WEAPON_MENTION", "WEAPON_SUPPRESSORS"),
    GateCategory.IMMINENT_TIME_MARKER: ("IMMINENT_TIME_MARKER", None),
}


def _ts_block(source: str, const_name: str) -> str:
    """The body of one `const NAME ... ` declaration, up to the next top-level const."""
    match = re.search(rf"^const {const_name}\b", source, re.MULTILINE)
    assert match, f"const {const_name} not found in patterns.ts"
    rest = source[match.end() :]
    nxt = re.search(r"^(?:const|export const) ", rest, re.MULTILINE)
    return rest[: nxt.start()] if nxt else rest


def _parse_ts_entries(block: str) -> dict[str, str]:
    """Extract `{pattern name: regex source}` from one bank's declaration body."""
    out: dict[str, str] = {}
    for match in _TS_ENTRY.finditer(block):
        chunks = re.findall(r"R`([^`]*)`", match.group("body"))
        name = match.group("name")
        assert name not in out, f"duplicate pattern name {name!r} within one TS bank"
        out[name] = "".join(chunks)
    return out


def _ts_patterns(source: str) -> dict[str, str]:
    """`{category:name: regex}` across every TS pattern bank."""
    out: dict[str, str] = {}
    for category, (const_name, _) in _TS_CONSTS.items():
        for name, rx in _parse_ts_entries(_ts_block(source, const_name)).items():
            out[f"{category.value}:{name}"] = rx
    return out


def _ts_suppressors(source: str) -> dict[str, str]:
    """`{category:name: regex}` across every TS suppressor bank."""
    out: dict[str, str] = {}
    for category, (_, const_name) in _TS_CONSTS.items():
        if const_name is None:
            continue
        for name, rx in _parse_ts_entries(_ts_block(source, const_name)).items():
            out[f"{category.value}:{name}"] = rx
    return out


@pytest.fixture(scope="module")
def ts_source() -> str:
    return TS_PATTERNS.read_text()


def _python_patterns() -> dict[str, str]:
    return {
        f"{category.value}:{name}": rx
        for category, bank in PATTERNS.items()
        for entries in bank.values()
        for name, rx in entries
    }


def _python_suppressors() -> dict[str, str]:
    return {
        f"{category.value}:{name}": rx
        for category, entries in SUPPRESSORS.items()
        for name, rx in entries
    }


def _compare(python: dict[str, str], ts: dict[str, str], what: str) -> None:
    missing = sorted(set(python) - set(ts))
    extra = sorted(set(ts) - set(python))
    assert not missing, f"{what} in Python but not in the TS port: {missing}"
    assert not extra, f"{what} in the TS port but not in Python: {extra}"

    differing = {k: (python[k], ts[k]) for k in python if ts[k] != python[k]}
    assert not differing, f"{what}: regex bodies differ between the runtimes:\n" + "\n".join(
        f"  {k}\n    py: {py}\n    ts: {t}" for k, (py, t) in differing.items()
    )


def test_every_pattern_is_character_identical(ts_source: str) -> None:
    """The regexes themselves must match, not just the names.

    The snapshot test above only constrains patterns that some conversation or probe
    actually triggers, and coverage is not complete: nothing in the corpus says "kys", so
    that pattern could be weakened in either runtime and all 354 verdicts would stay
    identical. Verified by deliberately breaking it — both suites stayed green. This closes
    that hole for all 66 patterns at once, with no reliance on corpus coverage.

    It works because the TS port uses `String.raw` and Python uses raw strings, so the two
    are meant to be byte-for-byte equal. If a genuine syntax difference between the
    flavours ever forces them apart, special-case that one pattern here with a comment
    saying why, rather than deleting the test.
    """
    _compare(_python_patterns(), _ts_patterns(ts_source), "patterns")


def test_every_suppressor_is_character_identical(ts_source: str) -> None:
    """Same argument as the patterns, and it matters more here.

    A drifted *pattern* usually means a missed detection, which the classifier may still
    catch. A drifted *suppressor* means the gate fires on "we used a butter knife in food
    tech" and puts a tier on a child who was talking about a cookery lesson.
    """
    _compare(_python_suppressors(), _ts_suppressors(ts_source), "suppressors")


def test_the_banks_are_the_size_the_docs_claim(ts_source: str) -> None:
    # context.md section 6 and the day 3 log both say 66 patterns and 21 suppressors. If
    # that stops being true, the docs are wrong and someone has to decide which is right.
    assert len(_python_patterns()) == 66
    assert len(_python_suppressors()) == 21
    assert len(_ts_patterns(ts_source)) == 66
    assert len(_ts_suppressors(ts_source)) == 21


def test_the_port_did_not_quietly_drop_a_category() -> None:
    taxonomy = TS_TAXONOMY.read_text()
    for category in PATTERNS:
        assert f'"{category.value}"' in taxonomy, (
            f"{category.value} is missing from the TS taxonomy mirror"
        )


# ---------------------------------------------------------------------------------------
# MIRRORED constants must hold the same values
# ---------------------------------------------------------------------------------------


def _ts_number(source: str, name: str) -> float:
    match = re.search(rf"export const {name} = ([0-9.]+);", source)
    assert match, f"{name} not found in config.ts"
    return float(match.group(1))


def _ts_string(source: str, name: str) -> str:
    match = re.search(rf'export const {name} = "([^"]+)";', source)
    assert match, f"{name} not found in config.ts"
    return match.group(1)


@pytest.fixture(scope="module")
def ts_config() -> str:
    return TS_CONFIG.read_text()


@pytest.mark.parametrize(
    "name,expected",
    [
        ("GATE_HIGH_SCORE", config.GATE_HIGH_SCORE),
        ("GATE_GREY_SCORE", config.GATE_GREY_SCORE),
        ("GATE_FLOOR_MIN_WEIGHT", config.GATE_FLOOR_MIN_WEIGHT),
        ("MAX_CITED_QUOTES", config.MAX_CITED_QUOTES),
        ("CONCERN_THRESHOLD", config.CONCERN_THRESHOLD),
        ("COUNSELLOR_WEEKLY_BUDGET", config.COUNSELLOR_WEEKLY_BUDGET),
        ("RETENTION_DAYS_NON_ESCALATED", config.RETENTION_DAYS_NON_ESCALATED),
        ("CLASSIFIER_TIMEOUT_SECONDS", config.CLASSIFIER_TIMEOUT_SECONDS),
    ],
)
def test_mirrored_numbers_match(ts_config: str, name: str, expected: float) -> None:
    assert _ts_number(ts_config, name) == pytest.approx(expected), (
        f"{name} differs between config.py and config.ts. Both are marked MIRRORED; "
        "change both or neither."
    )


def test_mirrored_intake_model_matches(ts_config: str) -> None:
    """Both runtimes must call the same model. A drift here means the chat and the
    entity extractor silently disagree about what they are talking to."""
    assert _ts_string(ts_config, "INTAKE_MODEL") == config.INTAKE_MODEL


def test_mirrored_ceiling_matches(ts_config: str) -> None:
    assert (
        _ts_string(ts_config, "GATE_CEILING_WITHOUT_T4_EVIDENCE")
        == config.GATE_CEILING_WITHOUT_T4_EVIDENCE
    )


def test_mirrored_severity_weights_match(ts_config: str) -> None:
    block = re.search(
        r"export const GATE_SEVERITY_WEIGHTS = \{(.*?)\}", ts_config, re.DOTALL
    )
    assert block, "GATE_SEVERITY_WEIGHTS not found in config.ts"
    found = {
        key: float(value)
        for key, value in re.findall(r"(\w+):\s*([0-9.]+)", block.group(1))
    }
    assert found == config.GATE_SEVERITY_WEIGHTS


# ---------------------------------------------------------------------------------------
# Crisis resources
# ---------------------------------------------------------------------------------------


def test_the_crisis_banner_only_carries_lines_that_answer_at_2am(ts_config: str) -> None:
    """Every resource on the T4 banner must be 24/7.

    A T4 gate hit can happen at 2am on a Sunday. A number that rings out is worse than no
    number: it costs a student the one attempt they were brave enough to make. Tinkle
    Friend is the specific trap here — it is Singapore's obvious child-focused line and it
    runs Mon-Fri 2.30pm-5pm, so it belongs in SUPPORT_RESOURCES with its hours printed,
    never in CRISIS_RESOURCES.
    """
    block = re.search(
        r"export const CRISIS_RESOURCES.*?^\] as const;", ts_config, re.DOTALL | re.MULTILINE
    )
    assert block, "CRISIS_RESOURCES not found in config.ts"
    body = block.group(0)

    hours = re.findall(r'hours:\s*"([^"]+)"', body)
    assert hours, "no hours declared on the crisis resources"
    for entry in hours:
        assert "24 hours" in entry, (
            f"crisis resource with non-24/7 hours {entry!r} is on the T4 banner"
        )

    assert "Tinkle Friend" not in body, (
        "Tinkle Friend runs Mon-Fri 2.30pm-5pm and must not appear on the crisis banner"
    )
    # A banner with no numbers on it is the failure this whole rule exists to prevent.
    assert len(re.findall(r'contact:\s*"', body)) >= 2
