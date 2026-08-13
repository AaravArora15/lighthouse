/**
 * Single-file tunables for the TypeScript runtime.
 *
 * Per the root CLAUDE.md: tunable constants live in exactly one file per runtime. This is
 * that file for `web/`. `ml/lighthouse/config.py` is the Python one.
 *
 * Anything marked MIRRORED has a counterpart in `config.py` carrying the same marker, and
 * the two must hold the same value. `ml/tests/test_ts_conformance.py` parses this file and
 * asserts the numbers match, so a drift fails the build rather than quietly changing where
 * a child's crisis banner appears.
 */

// ---------------------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------------------

/**
 * At or above this weighted score the gate is "high": crisis resources render
 * unconditionally, before any model output. MIRRORED.
 */
export const GATE_HIGH_SCORE = 0.7;

/**
 * Between grey and high the gate is uncertain: it does not floor, but it marks the case
 * as grey_risk, which is an escalation signal for the conversation head. MIRRORED.
 */
export const GATE_GREY_SCORE = 0.35;

/**
 * Per-match weights for the three graded pattern families. MIRRORED.
 *
 * Chosen so the score bands mean something rather than being arbitrary decimals, given the
 * noisy-OR aggregation in `gate/safety.ts`:
 *
 *   one STRONG match      -> 1.00, high
 *   two MODERATE matches  -> 0.84, high      (two independent concerning readings)
 *   one MODERATE match    -> 0.60, grey
 *   two WEAK matches      -> 0.51, grey
 *   one WEAK match        -> 0.30, clear     (a topic word with no stance)
 */
export const GATE_SEVERITY_WEIGHTS = {
  strong: 1.0,
  moderate: 0.6,
  weak: 0.3,
} as const;

/**
 * A category only contributes a tier floor if it matched at this weight or above.
 *
 * This is the line that stops the gate from de-anonymising a child over the word "knife".
 * WEAK matches still raise the score and can push a case into the grey band, which routes
 * it to the conversation head; they just cannot force a tier on their own. MIRRORED.
 */
export const GATE_FLOOR_MIN_WEIGHT = 0.6;

/**
 * The highest tier the gate permits when no T4-capable category fired. MIRRORED.
 *
 * The floor rule protects against under-reacting. This protects against over-reacting,
 * which is not a symmetric concern but is a real one: T4 means break-glass, and
 * break-glass means lifting a student's anonymity.
 */
export const GATE_CEILING_WITHOUT_T4_EVIDENCE = "T3";

// ---------------------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------------------

/**
 * A turn is "concerning" at or above this risk (`1 - P(none)`). MIRRORED.
 *
 * Two things read it and they must agree: the conversation features count turns above it
 * (`count_above_tau`, `frac_above_tau`), and the escalation card refuses to cite a turn
 * below it as evidence. If the card used a looser bar than the model, it would quote
 * messages the model itself did not consider concerning.
 */
export const CONCERN_THRESHOLD = 0.5;

/**
 * Cases one counsellor gets through in a week. MIRRORED.
 *
 * The denominator of recall@budget, and the line drawn across the queue. It is an
 * assumption, not a measurement — it is printed next to every number derived from it so a
 * school can reject it and recompute.
 */
export const COUNSELLOR_WEEKLY_BUDGET = 20;

// ---------------------------------------------------------------------------------------
// Escalation card
// ---------------------------------------------------------------------------------------

/** Hard cap. A card with more than three quotes stops being scannable. MIRRORED. */
export const MAX_CITED_QUOTES = 3;

// ---------------------------------------------------------------------------------------
// Counsellor auth
// ---------------------------------------------------------------------------------------

/**
 * A session lasts one working day.
 *
 * Long enough that a counsellor is not re-authenticating between cases, short enough that
 * a laptop left open in a staff room stops being a way into the queue by the next morning.
 * TypeScript only: there is no Python counterpart, so this is not MIRRORED.
 */
export const SESSION_TTL_HOURS = 12;

/**
 * Minimum password length, and deliberately the only rule.
 *
 * Composition requirements ("one uppercase, one symbol") measurably push people toward
 * `Password1!` and toward writing it on a sticky note beside a screen that displays
 * children's disclosures. Length is the property that correlates with strength.
 */
export const MIN_PASSWORD_CHARS = 12;

// ---------------------------------------------------------------------------------------
// Reason thresholds
// ---------------------------------------------------------------------------------------

/**
 * How much a counsellor has to write before an action goes through, by action.
 *
 * **One table, because these were four.** The transcript threshold lived in
 * `privacy/disclosure.ts`, the unseal threshold in both `privacy/seal.ts` and
 * `disclosure.ts`, and the override threshold as a bare `10` in the route handler and
 * again in `overrides.ts`. Four copies of a number that expresses a single policy is four
 * chances for the UI to promise one thing and the server to enforce another.
 *
 * The ordering is the argument: reading a transcript is routine and costs a sentence;
 * lifting a child's anonymity costs more; overruling the safety gate costs most, because a
 * safeguarding lead will read that one weeks later with no memory of the case and has to
 * be able to tell whether the call was reasonable.
 */
export const REASON_CHARS = {
  /** Opening the full redacted transcript. */
  transcript: 10,
  /** Recording a tier override. */
  override: 10,
  /** Unsealing identifying spans. */
  unseal: 20,
  /** Closing a case below the gate's floor. */
  breakGlass: 40,
  /** A lead's note when reviewing a break-glass. */
  breakGlassReview: 10,
} as const;

// ---------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------

/**
 * Non-escalated conversations auto-delete after this many days. The student is told this
 * number up front, so it must match the consent copy. MIRRORED.
 */
export const RETENTION_DAYS_NON_ESCALATED = 30;

// ---------------------------------------------------------------------------------------
// Classifier service
// ---------------------------------------------------------------------------------------

/** Past this, live chat degrades to gate-only triage and says so in the UI. MIRRORED. */
export const CLASSIFIER_TIMEOUT_SECONDS = 4.0;

// ---------------------------------------------------------------------------------------
// Crisis resources
// ---------------------------------------------------------------------------------------

export interface CrisisResource {
  readonly name: string;
  /** Dialable as printed. Rendered as a tel: link on mobile. */
  readonly contact: string;
  readonly hours: string;
  readonly note?: string;
  /** Secondary channel (WhatsApp, webchat) for students who cannot speak out loud. */
  readonly alternative?: { readonly label: string; readonly value: string };
}

/**
 * Rendered to the student on a T4 gate floor, before any model output, and still rendered
 * when the LLM call fails, times out, or refuses. This is a product non-negotiable
 * (CLAUDE.md), not a nice-to-have.
 *
 * Region: Singapore. Verified 2026-08-08 against each operator's own site.
 *
 * **Every line here must be 24/7.** A T4 gate hit can happen at 2am on a Sunday, and a
 * number that does not answer is worse than no number at all: it costs a student the one
 * attempt they were brave enough to make. That rule is why Tinkle Friend (1800 2744 788)
 * is deliberately NOT in this list despite being the obvious child-focused service in
 * Singapore — it runs Mon-Fri 2.30pm-5pm only. It belongs in a lower-tier support list
 * with its hours printed, not on a crisis banner.
 *
 * Re-verify before any public deployment. Helpline numbers change: SOS moved to 1767 from
 * its previous 1800-221-4444, and mindline 1771 only launched in June 2025.
 */
export const CRISIS_RESOURCES: readonly CrisisResource[] = [
  {
    name: "Samaritans of Singapore (SOS)",
    contact: "1767",
    hours: "24 hours, every day",
    note: "Free and confidential.",
    alternative: { label: "CareText on WhatsApp", value: "9151 1767" },
  },
  {
    name: "national mindline 1771",
    contact: "1771",
    hours: "24 hours, every day",
    note: "Free, anonymous, run by the Institute of Mental Health.",
    alternative: { label: "WhatsApp", value: "6669 1771" },
  },
  {
    name: "Emergency services",
    contact: "995",
    hours: "24 hours, every day",
    note: "If you are in immediate danger, or someone needs medical help right now.",
  },
] as const;

/**
 * Non-crisis support, shown outside the T4 banner. Hours are printed because these lines
 * are not 24/7 and a student needs to know that before they dial.
 */
export const SUPPORT_RESOURCES: readonly CrisisResource[] = [
  {
    name: "Tinkle Friend",
    contact: "1800 2744 788",
    hours: "Mon-Fri, 2.30pm-5pm",
    note: "Singapore Children's Society, for primary-school-aged children.",
  },
] as const;

// ---------------------------------------------------------------------------------------
// Chat intake
// ---------------------------------------------------------------------------------------

/** Longer than this and the intake box stops being a chat. Matches MAX_TURN_CHARS. */
export const MAX_TURN_CHARS = 1000;

/**
 * Hard cap on the number of messages one `POST /api/chat` may carry.
 *
 * The route is unauthenticated and the client controls the whole array, so without this
 * the input size of a paid call is whatever a caller decides to send: 4,000 turns of
 * 1,000 characters is roughly a million tokens of input, which is about **$5 in a single
 * HTTP request** and a proportional Neon write besides. This constant is the only thing
 * between the deployed key and that, short of a console spend limit.
 *
 * 40 messages is 20 student turns and 20 replies. A real intake is well short of that.
 *
 * Over the cap the request is **rejected**, not trimmed. Dropping the oldest turns would
 * be gentler on a long session, but it would also erase the earliest disclosure from both
 * the counsellor's copy and the conversation verdict — and a weapon named in turn 2 plus
 * "after school" in turn 30 is exactly the pair the conversation gate exists to catch.
 * Silently forgetting the first half of a disclosure is a worse failure than a 400.
 */
export const MAX_CONVERSATION_TURNS = 40;

/**
 * Model used for the intake replies. The LLM listens and keeps the student talking; it
 * never assigns a tier and never counsels. See CLAUDE.md.
 */
export const INTAKE_MODEL = "claude-opus-5";

/** Cap on intake replies. The assistant asks one short question, it does not lecture. */
export const INTAKE_MAX_TOKENS = 300;

/**
 * SDK retries per intake call. The SDK default is 2, which is wrong here in both
 * directions.
 *
 * Wall clock: a request that times out at CLASSIFIER_TIMEOUT_SECONDS is retried, so the
 * default turns a 4s ceiling into a 12s one while a distressed student watches an empty
 * bubble. Cost: the calls most likely to time out are the expensive ones, and the default
 * bills them three times.
 *
 * One retry, not zero, because a 429 or a 529 is genuinely transient and the scripted
 * reply is a real downgrade in warmth. Worst case is now two attempts, 8s, then a
 * scripted reply with a visible notice.
 */
export const INTAKE_MAX_RETRIES = 1;
