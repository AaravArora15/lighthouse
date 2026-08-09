/**
 * PII redaction. Runs before anything is written to the database.
 *
 * `docs/context.md` §11 promises the transcript is redacted before storage and that the
 * identifying spans live separately, encrypted, unsealed only on escalation. This module
 * is the first half of that: it finds the spans and replaces them with typed placeholders.
 * `seal.ts` encrypts what came out.
 *
 * ## Where this sits, and why the ordering is not negotiable
 *
 *     raw turn
 *       -> safety gate            (needs raw text: "kai" is a name the gate ignores, but
 *                                   "he'll batter me" around it is not)
 *       -> quote selection        (offsets into raw text)
 *       -> REDACTION              <- here
 *       -> storage                (redacted transcript + sealed PII map)
 *
 * Redaction is deliberately **last**. Two things depend on that:
 *
 * 1. The gate reads real text. Redacting first would replace a name with a placeholder
 *    inside a phrase the gate is matching on, and a pattern like
 *    `reported_threat_against_student` matches on the words around the name.
 * 2. Offsets stay valid. Gate spans and cited quotes are computed against raw text, and
 *    a placeholder is a different length from the name it replaces, so every offset would
 *    shift. By the time redaction runs, offsets have already been consumed — quotes are
 *    extracted as strings and then redacted independently.
 *
 * If you ever move redaction earlier, both of those break silently rather than loudly.
 *
 * ## Two detectors, because PII comes in two shapes
 *
 * **Structured PII** — phone, email, URL, postcode, address — has reliable form, so regex
 * finds it regardless of how the student types.
 *
 * **Names and places** do not, and the first version of this file got that wrong. Its
 * name detectors all required a capital letter, which was measured against the real
 * corpus and found to redact **0 of 260 student turns**: children type in lowercase, and
 * "kai took my bag off me" carries no capital anywhere. Capitalisation is a property of
 * careful writing, not of chat.
 *
 * So names arrive via `KnownEntities`, produced upstream by `cluster/entities.py`, which
 * already asks an LLM for the people and places a transcript names and already gets "kai"
 * out of exactly those turns. This module matches them literally and case-insensitively.
 *
 * ## The honest limitation
 *
 * With no `known` list, lowercase names survive redaction. That is a real gap, stated
 * rather than hidden, and it is why `looksIdentifying` exists as a boundary assertion and
 * why the README must say this **reduces the identifying surface of stored text** rather
 * than claiming anonymisation.
 */

/** What a redacted span was. The placeholder shows this to the counsellor. */
export type PiiType =
  | "name"
  | "phone"
  | "email"
  | "handle"
  | "url"
  | "postcode"
  | "address"
  | "school"
  | "place";

export interface PiiSpan {
  type: PiiType;
  /** Offsets into the ORIGINAL text passed to `redact`. */
  start: number;
  end: number;
  /** The exact original substring. This is what gets sealed. */
  text: string;
  /** What replaced it, e.g. `[name]`. Stable per (type, normalised text) within one call. */
  placeholder: string;
}

export interface Redaction {
  /** Safe to store, safe to show a counsellor, safe to put in a log. */
  redacted: string;
  /** Ordered by position. Feed to `seal.ts` — never write these to the database raw. */
  spans: PiiSpan[];
}

// ---------------------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------------------
//
// Ordered by precedence: earlier detectors win an overlapping span. Email before URL
// before handle, because "@" appears in all three and the most specific reading is the
// most useful one to a counsellor.

interface Detector {
  type: PiiType;
  rx: RegExp;
  /** Which capture group holds the span to redact. 0 = the whole match. */
  group?: number;
}

/**
 * Words that look like names in the cue patterns below but are not.
 *
 * Without this, "my mum hits me" redacts to "my [name] hits me" and the counsellor loses
 * the single most important word in the sentence. Relationship words are not identifying
 * on their own — there are a lot of mums — and the gate's own patterns match on them.
 */
const NOT_A_NAME = new Set([
  "mum", "mom", "mother", "dad", "father", "brother", "sister", "nan", "nana",
  "gran", "grandma", "grandad", "uncle", "aunt", "auntie", "cousin", "stepdad",
  "stepmum", "carer", "teacher", "miss", "sir", "friend", "mate", "bestfriend",
  "everyone", "everybody", "someone", "somebody", "nobody", "anyone", "people",
  "them", "him", "her", "they", "she", "he", "it", "one", "two", "school",
  "class", "year", "home", "work", "today", "tomorrow", "yesterday", "monday",
  "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

const DETECTORS: Detector[] = [
  {
    type: "email",
    rx: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  },
  {
    type: "url",
    rx: /\bhttps?:\/\/\S+|\bwww\.[\w-]+\.\S+/g,
  },
  {
    // UK/SG-ish mobile shapes plus generic long digit runs. Deliberately loose: a
    // false positive costs a redacted phone-shaped number, a false negative costs a
    // contactable child.
    type: "phone",
    rx: /\b(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){7,14}\d\b/g,
  },
  {
    type: "postcode",
    rx: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b|\bSingapore\s?\d{6}\b/gi,
  },
  {
    type: "handle",
    rx: /(?:^|[\s(])@([A-Za-z0-9_.]{2,30})\b/g,
    group: 1,
  },
  {
    // "12 Elm Road", "flat 4 Oakfield Court"
    type: "address",
    rx: /\b\d{1,4}[a-z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:road|rd|street|st|avenue|ave|lane|ln|close|court|crescent|drive|way|grove|terrace)\b/gi,
  },
  {
    type: "school",
    rx: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:School|Academy|College|High|Primary|Secondary)\b/g,
  },
  {
    // Names, found by the cue that precedes them rather than by a name list. A lexicon
    // of first names cannot cover a multilingual school; a cue like "called X" or
    // "X said" generalises to any spelling.
    type: "name",
    rx: /\b(?:called|named|nicknamed|his name is|her name is|their name is)\s+([A-Z]?[a-z]+)\b/g,
    group: 1,
  },
  {
    // Capitalised token in a subject-verb position: "Kai pushed me", "Jamie said".
    // Requires the capital, so it does not fire on ordinary lowercase chat.
    type: "name",
    rx: /\b([A-Z][a-z]{1,20})\s+(?:said|says|told|pushed|hit|kicked|punched|threatened|started|keeps|calls|called|took|threw|shoved|laughed|filmed)\b/g,
    group: 1,
  },
  {
    // "me and Kai", "with Jamie", "to Alex"
    type: "name",
    rx: /\b(?:and|with|to|from|about|like|than)\s+([A-Z][a-z]{1,20})\b/g,
    group: 1,
  },
  {
    // A name in OBJECT position: "Kai told Jamie", "he pushed Alex".
    //
    // Added after a test caught "Kai told Jamie about it" redacting only the first name.
    // The subject-position detector above reads left-to-right off the verb and stops
    // there, so the second person in any sentence with two people survived — and a
    // sentence naming two people is exactly the shape a bullying report takes.
    type: "name",
    rx: /\b(?:told|telling|tells|pushed|hit|kicked|punched|threatened|texted|messaged|called|followed|filmed|blocked|reported)\s+([A-Z][a-z]{1,20})\b/g,
    group: 1,
  },
];

interface RawSpan {
  type: PiiType;
  start: number;
  end: number;
  text: string;
}

/**
 * Names and places already extracted from this conversation, in plaintext.
 *
 * **This is how names are actually found.** The regex detectors below all require a
 * capital letter, and a measurement against the real corpus showed why that is not
 * enough: 0 of 260 student turns had anything redacted, because students type in
 * lowercase. "kai took my bag off me" carries no capital anywhere.
 *
 * Capitalisation is a property of careful writing, not of chat, so it cannot be the
 * signal. The signal that does work is already computed upstream: `cluster/entities.py`
 * asks an LLM for the people and places a transcript names and gets "kai" from exactly
 * these turns. Redaction consumes that list and matches it literally, case-insensitively.
 *
 * The division of labour is deliberate:
 *   - structured PII (phone, email, URL, postcode, address) -> regex. Reliable shape,
 *     no capitalisation dependency, and no model call needed.
 *   - names and places -> the extractor. Open-class, no reliable shape.
 *
 * When `known` is empty the regex detectors still run, so redaction degrades rather than
 * failing if extraction was unavailable. It degrades to *missing lowercase names*, which
 * is why the storage boundary asserts and the README says this reduces identifying
 * surface rather than anonymising.
 */
export interface KnownEntities {
  people?: readonly string[];
  places?: readonly string[];
}

/** Escape a plaintext entity for use inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectSpans(text: string, known: KnownEntities = {}): RawSpan[] {
  const found: RawSpan[] = [];

  // Known entities first, so they win any overlap with a regex detector: an LLM that
  // read the whole transcript is a better authority on whether a token is a name than a
  // capitalisation heuristic.
  for (const [type, values] of [
    ["name", known.people ?? []],
    ["place", known.places ?? []],
  ] as const) {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length < 2) continue;
      const re = new RegExp(`\\b${escapeLiteral(trimmed)}\\b`, "gi");
      for (const m of text.matchAll(re)) {
        found.push({
          type: type as PiiType,
          start: m.index ?? 0,
          end: (m.index ?? 0) + m[0].length,
          text: m[0],
        });
      }
    }
  }

  for (const { type, rx, group = 0 } of DETECTORS) {
    // Clone so the shared literal's lastIndex is never carried between calls.
    const re = new RegExp(rx.source, rx.flags);
    for (const m of text.matchAll(re)) {
      const whole = m[0];
      const value = group === 0 ? whole : m[group];
      if (!value) continue;

      if (type === "name" && NOT_A_NAME.has(value.toLowerCase())) continue;
      // A phone detector on "twice this week" style digit runs would be noise; require
      // enough digits to actually be a number.
      if (type === "phone" && (value.replace(/\D/g, "").length < 8)) continue;

      const offsetInMatch = group === 0 ? 0 : whole.indexOf(value);
      const start = (m.index ?? 0) + offsetInMatch;
      found.push({ type, start, end: start + value.length, text: value });
    }
  }

  // Earlier detector wins an overlap, then longer span, then earlier position. Sorting
  // before the sweep is what makes precedence deterministic rather than dependent on
  // which regex happened to match first.
  const knownValues = new Set(
    [...(known.people ?? []), ...(known.places ?? [])].map((v) => v.trim().toLowerCase()),
  );
  const priority = (s: RawSpan): number =>
    knownValues.has(s.text.toLowerCase())
      ? -1 // an extracted entity outranks any heuristic
      : DETECTORS.findIndex((d) => d.type === s.type);

  found.sort(
    (a, b) =>
      priority(a) - priority(b) ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  );

  const kept: RawSpan[] = [];
  for (const span of found) {
    if (kept.some((k) => span.start < k.end && k.start < span.end)) continue;
    kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------

/**
 * Replace every detected span with a typed placeholder.
 *
 * The same value appearing twice gets the same numbered placeholder, so a counsellor
 * reading "[name 1] told [name 2]" can follow who is who without learning either name.
 * That numbering is **per call**, so it carries no meaning across conversations — two
 * transcripts both mentioning `[name 1]` are not making a claim about the same person.
 * Cross-conversation identity is the clustering layer's job, and it uses keyed HMAC
 * pseudonyms precisely so this layer does not have to.
 */
export function redact(text: string, known: KnownEntities = {}): Redaction {
  if (!text) return { redacted: "", spans: [] };

  const spans = detectSpans(text, known);
  if (spans.length === 0) return { redacted: text, spans: [] };

  const numbering = new Map<string, number>();
  const counts = new Map<PiiType, number>();

  const out: PiiSpan[] = [];
  let result = "";
  let cursor = 0;

  for (const span of spans) {
    const key = `${span.type}:${span.text.toLowerCase()}`;
    let n = numbering.get(key);
    if (n === undefined) {
      n = (counts.get(span.type) ?? 0) + 1;
      counts.set(span.type, n);
      numbering.set(key, n);
    }
    // Only number a type once it is ambiguous. "[name]" reads better than "[name 1]"
    // when there is exactly one person in the transcript.
    const placeholder = `[${span.type}${n > 1 || (counts.get(span.type) ?? 0) > 1 ? ` ${n}` : ""}]`;

    result += text.slice(cursor, span.start) + placeholder;
    cursor = span.end;
    out.push({ ...span, placeholder });
  }
  result += text.slice(cursor);

  // A second pass fixes the singular/plural read: if a type turned out to have several
  // distinct values, the first one was already written unnumbered. Rewrite it.
  for (const [type, total] of counts) {
    if (total > 1) {
      result = result.replace(`[${type}]`, `[${type} 1]`);
      for (const s of out) {
        if (s.type === type && s.placeholder === `[${type}]`) s.placeholder = `[${type} 1]`;
      }
    }
  }

  return { redacted: result, spans: out };
}

/** Redact every turn of a transcript, keeping spans attributed to their turn. */
export function redactTranscript(
  turns: readonly string[],
  known: KnownEntities = {},
): { redacted: string[]; spans: (PiiSpan & { turnIndex: number })[] } {
  const redacted: string[] = [];
  const spans: (PiiSpan & { turnIndex: number })[] = [];
  turns.forEach((turn, turnIndex) => {
    const result = redact(turn, known);
    redacted.push(result.redacted);
    spans.push(...result.spans.map((s) => ({ ...s, turnIndex })));
  });
  return { redacted, spans };
}

/**
 * True when the text still contains something that looks identifying.
 *
 * Used as an assertion at the storage boundary rather than as a detector — if this
 * returns true for text about to be written, redaction failed and the write should not
 * happen. Cheap enough to run on every insert.
 */
export function looksIdentifying(text: string, known: KnownEntities = {}): boolean {
  return detectSpans(text, known).length > 0;
}
