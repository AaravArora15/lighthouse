/**
 * Graded regex families for the deterministic safety gate — TypeScript mirror.
 *
 * A line-for-line port of `ml/lighthouse/gate/patterns.py`. The reasoning behind each
 * decision lives in the Python file and in `docs/context.md` section 6; it is not repeated
 * here, because two copies of a rationale drift and then you have two rationales. What is
 * repeated is anything a reader needs to avoid breaking the port itself.
 *
 * **Why this is a port and not an HTTP call.** The gate has to render crisis numbers when
 * the Python side is unreachable, and on day 9 the Python side is a free HF Space that
 * sleeps after 48h and takes ~30s to wake. A gate behind that call would fail exactly when
 * it is needed. So it runs in-process, in both runtimes, and `ml/tests/test_ts_conformance.py`
 * runs both over the same 80 conversations and diffs every verdict field.
 *
 * 66 patterns, 21 suppressors. If you change one, change the Python one in the same commit.
 */

import { GateCategory, GATE_CATEGORY_ORDER } from "@/lib/taxonomy";

export enum Severity {
  STRONG = "strong",
  MODERATE = "moderate",
  WEAK = "weak",
}

/** Weakest first. The matcher walks this reversed, so STRONG claims spans first. */
export const SEVERITY_ORDER: readonly Severity[] = [
  Severity.WEAK,
  Severity.MODERATE,
  Severity.STRONG,
] as const;

// ---------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------

/**
 * Character-level filter evasion, mapped back to letters. Every entry is a single
 * character replaced by a single character, which keeps `normalize` length-preserving.
 *
 * That property is load-bearing: match spans are reported against the ORIGINAL text so
 * escalation cards can quote a student verbatim. `*` is deliberately absent rather than
 * mapped to "", because removing a character would shift every subsequent offset.
 */
const LEET: Readonly<Record<string, string>> = {
  "!": "i",
  "1": "i",
  "|": "i",
  "3": "e",
  "4": "a",
  "0": "o",
  "@": "a",
  $: "s",
  "5": "s",
  "7": "t",
};

/**
 * Lowercase and undo single-character leetspeak. Length-preserving, always.
 *
 * Digits are mapped unconditionally, so `"im 14"` normalises to `"im ia"`. Ugly but
 * harmless: nothing in the banks matches bare digit-shaped tokens, and the alternative
 * (token-aware mapping) costs the 1:1 offset guarantee.
 */
export function normalize(text: string): string {
  let out = "";
  const lowered = text.toLowerCase();
  for (const ch of lowered) out += LEET[ch] ?? ch;
  return out;
}

// ---------------------------------------------------------------------------------------
// The banks
// ---------------------------------------------------------------------------------------
//
// Each entry is [name, source]. The name is what a counsellor sees; it must read as an
// explanation, not as an internal ID. The regex is never shown to anyone.

export type PatternEntry = readonly [name: string, source: string];
export type Bank = Partial<Record<Severity, readonly PatternEntry[]>>;

const R = String.raw;

const SELF_HARM_INTENT: Bank = {
  [Severity.STRONG]: [
    [
      // The filler group carries `have`/`had` as well as `been`. Found on day 5 by
      // running the live chat route: "i've been cutting my arms" floored at T4 and
      // "i have been cutting my arms" floored at nothing, purely because the contraction
      // was expanded. The sibling pattern `first_person_self_harm_term` already listed
      // `have\s+been`, so this was an oversight in one pattern rather than a decision.
      "first_person_cutting",
      R`\b(i|i'?ve|ive)\s+(been\s+|have\s+|had\s+|just\s+|already\s+|started\s+)*` +
        R`(cut|cuts|cutting|burnt|burned|burning|scratched|scratching)\s+` +
        R`(myself|my\s+(arm|arms|wrist|wrists|leg|legs|thigh|thighs|skin))\b`,
    ],
    [
      "stated_intent_to_self_injure",
      R`\bi\s+(want|wanna|need|have|am\s+going|'?m\s+going|going)\s+to\s+` +
        R`(cut|hurt|harm|burn)\s+myself\b`,
    ],
    ["cut_again", R`\bi\s+(cut|hurt)\s+(myself\s+)?again\b`],
    [
      "first_person_self_harm_term",
      R`\bi\s+(have\s+been|'?ve\s+been|am|'?m|was|started|stopped|relapsed)\s+` +
        R`\w*\s*self[\s\-]?harm(ing|ed)?\b`,
    ],
    ["relapse_with_injury", R`\bi\s+relapsed\b.{0,40}\b(cut|cutting|blade|razor)\b`],
  ],
  [Severity.MODERATE]: [
    ["self_harm_term", R`\bself[\s\-]?harm(ing|ed|s)?\b`],
    ["hurting_myself", R`\bhurt(ing)?\s+myself\b`],
    ["deserves_pain", R`\bi\s+deserve\s+(the\s+|this\s+)?(pain|to\s+hurt|it)\b`],
    ["own_scars", R`\bmy\s+(cuts|scars|wounds)\b`],
  ],
  [Severity.WEAK]: [
    ["injury_objects", R`\b(razor|razors|blade|blades)\b`],
    ["hiding_arms", R`\b(long\s+sleeves|cover\s+my\s+arms|hide\s+my\s+arms)\b`],
  ],
};

const SUICIDAL_IDEATION: Bank = {
  [Severity.STRONG]: [
    [
      // The intensifier slot is not decoration. "i do want to die" and "i just want to
      // die" are both common and both were missed by the first version of this pattern.
      "stated_intent_to_die",
      R`\bi\s+(do\s+|really\s+|just\s+|genuinely\s+|honestly\s+|kind\s?of\s+|` +
        R`kinda\s+|sometimes\s+|always\s+)*` +
        R`(want|wanna|need|have)\s+to\s+` +
        R`(die|end\s+it(\s+all)?|end\s+my\s+life|not\s+exist|not\s+be\s+here|` +
        R`not\s+wake\s+up|disappear\s+forever)\b`,
    ],
    ["kill_myself", R`\b(kill(ing)?|killed)\s+my\s?self\b`],
    ["unalive_myself", R`\bun\s?alive\s+my\s?self\b`],
    ["euphemism_sewerslide", R`\bsewer\s?slide\b`],
    ["abbreviation_kms", R`\bkms\b`],
    [
      "going_to_end_it",
      R`\b(i'?m|im|i\s+am)\s+(going\s+to|gonna|gna|about\s+to)\s+` +
        R`(end\s+it(\s+all)?|end\s+my\s+life|do\s+it\s+tonight)\b`,
    ],
    ["take_my_own_life", R`\btake\s+my\s+own\s+life\b`],
    [
      "wish_i_was_dead",
      R`\bi\s+wish\s+i\s+(was|were|had\s+never\s+been\s+born)\b(\s+dead|\s+gone)?\b`,
    ],
    [
      "first_person_suicidal",
      R`\bi\s+(am|'?m|feel|'?ve\s+been|have\s+been)\s+(really\s+|so\s+|very\s+)?suicidal\b`,
    ],
    // Preparation. The highest-precision signals in the whole gate: nobody writes them
    // casually, and each indicates a plan rather than an idea. The qualifier on
    // `wrote_a_note` is mandatory, not optional — without it, "i wrote a note for my mum"
    // floored at T4 and would have de-anonymised a child for writing a note.
    [
      "wrote_a_note",
      R`\b(i\s+)?(wrote|written|writing|finished|left)\s+(a\s+|my\s+)?` +
        R`(suicide|goodbye|good\s?bye|final|last)\s+(note|letter|message)\b`,
    ],
    [
      "note_for_when_im_gone",
      R`\b(note|letter|message)\s+for\s+(when|after)\s+` +
        R`i'?m\s+(gone|not\s+here|not\s+around)\b`,
    ],
    [
      "saved_pills",
      R`\b(saved|saving|collected|collecting|been\s+taking)\s+up?\s*` +
        R`(my\s+)?(pills|tablets|meds|medication)\b`,
    ],
    [
      "giving_things_away",
      R`\bgiving\s+(away\s+)?(all\s+)?my\s+(stuff|things|clothes|games)\s+away\b`,
    ],
    // Method, not just wish. A student who has worked out how is materially further along,
    // and no pattern above catches it: this phrasing has no verb of intent and no risk noun.
    [
      "has_a_method_in_mind",
      R`\bi'?(ve|\s+have)?\s*(thought|think|been\s+thinking)\s+` +
        R`about\s+how\s+(i'?d|i\s+would|to)\s+do\s+it\b`,
    ],
    ["knows_how_theyd_do_it", R`\bi\s+know\s+how\s+(i'?d|i\s+would)\s+do\s+it\b`],
    [
      "has_a_plan",
      R`\bi'?(ve|\s+have)\s+(got\s+)?a\s+plan\s+(for|to)\s+(end|kill|when)\b`,
    ],
  ],
  [Severity.MODERATE]: [
    [
      "does_not_want_to_be_here",
      R`\bi\s+(don'?t|do\s+not|dont)\s+want\s+to\s+` +
        R`(be\s+here|be\s+alive|live|wake\s+up|exist)\b`,
    ],
    [
      "better_off_without_me",
      R`\b(everyone|everybody|they|my\s+(family|mum|mom|dad|parents))\s+` +
        R`(would\s+be|'?d\s+be|are|is)\s+better\s+off\s+without\s+me\b`,
    ],
    [
      "no_point_living",
      R`\bwhat'?s\s+the\s+point\s+(of|in)\s+` +
        R`(living|being\s+here|any\s?of\s?this|anything)\b`,
    ],
    ["suicide_term", R`\bsuicid(e|al)\b`],
    ["nobody_would_notice", R`\bno\s?body\s+would\s+(notice|care|miss\s+me)\b`],
    [
      // A student reporting a friend's ideation. Deliberately MODERATE, not STRONG, and
      // deliberately a pattern rather than a suppressor: suppressing it made "my friend
      // said she wants to die and i'm scared" score 0.00 and vanish. MODERATE floors at T3
      // (a counsellor within 24h) instead of T4, because breaking glass on the *reporting*
      // student is the wrong response to a disclosure about somebody else.
      "third_party_disclosure",
      R`\bmy\s+(friend|mate|best\s?friend|sister|brother|cousin|classmate)\s+` +
        R`\w{0,10}\s*(said|says|told\s+me|wants|keeps\s+saying|is|has\s+been)\s+` +
        R`(that\s+)?(she|he|they)?\s*(wants?\s+to\s+|is\s+going\s+to\s+)?` +
        R`(die|kill\s+(her|him|them)\s?self|end\s+it|suicidal|self[\s\-]?harming)\b`,
    ],
  ],
  [Severity.WEAK]: [
    ["cannot_go_on", R`\bi\s+can'?t\s+(do\s+this|go\s+on|keep\s+going)\s+(any\s?more)?\b`],
    ["wants_to_disappear", R`\bi\s+(just\s+)?want\s+to\s+disappear\b`],
    [
      "tired_of_everything",
      R`\b(i'?m|im)\s+(so\s+)?tired\s+of\s+(everything|all\s+of\s+this|being\s+here)\b`,
    ],
  ],
};

const ABUSE_DISCLOSURE: Bank = {
  [Severity.STRONG]: [
    [
      "caregiver_violence",
      R`\b(my\s+)?(dad|father|mum|mom|mother|step\s?dad|step\s?father|step\s?mum|` +
        R`step\s?mom|uncle|aunt|older\s+brother|brother|cousin|coach|carer|` +
        R`foster\s+(dad|mum|mom|parent))\s+` +
        R`(hits|hit|beats|beat|punched|punches|kicked|kicks|strangled|` +
        R`burnt|burned|hurts|hurt)\s+me\b`,
    ],
    [
      "sexual_abuse_disclosure",
      R`\b(touch(ed|es|ing)?)\s+me\s+` +
        R`(inappropriately|where\s+he\s+shouldn'?t|down\s+there|when\s+i\s+was\s+` +
        R`asleep|in\s+a\s+way\s+i\s+didn'?t\s+like)\b`,
    ],
    ["made_me_do_things", R`\bmade\s+me\s+(touch|do)\s+(him|her|things|stuff)\b`],
    [
      "beaten_at_home",
      R`\bi\s+(get|got|keep\s+getting)\s+` +
        R`(hit|beaten|beat\s+up|slapped|punched)\s+at\s+home\b`,
    ],
    [
      "home_not_safe",
      R`\b(it'?s|i'?m|im)\s+not\s+safe\s+(at\s+home|there|in\s+my\s+(house|home))\b`,
    ],
  ],
  [Severity.MODERATE]: [
    // MODERATE, not STRONG. A classic abuse red flag, but "scared to go home" also covers
    // a failed test and a lost phone. T3 puts a human on it inside 24h, which is
    // proportionate to a phrase with a live benign reading.
    [
      "afraid_to_go_home",
      R`\b(scared|afraid|terrified|dreading)\s+(to\s+go|of\s+going|going)\s+home\b`,
    ],
    [
      "scared_of_caregiver",
      R`\b(scared|afraid|terrified)\s+of\s+(my\s+)?` +
        R`(dad|father|mum|mom|mother|step\s?dad|step\s?mum|step\s?mom|uncle|carer)\b`,
    ],
    ["bruises_from_home", R`\bbruis(e|es|ed|ing)\b.{0,50}\b(home|dad|mum|mom|him|her)\b`],
    [
      "nobody_at_home_safe",
      R`\bi\s+(can'?t|cannot)\s+(tell|talk\s+to)\s+(anyone\s+)?at\s+home\b`,
    ],
  ],
  [Severity.WEAK]: [
    ["home_is_bad", R`\bthings\s+(are|get)\s+(bad|worse)\s+at\s+home\b`],
    ["hiding_at_home", R`\b(hide|hiding|lock(ed)?\s+myself)\s+in\s+my\s+room\b`],
  ],
};

const THREAT_OF_VIOLENCE: Bank = {
  [Severity.STRONG]: [
    [
      // The target list is closed on purpose. An earlier version ended with a bare `\w+`,
      // which made "i'm going to end it all tonight" and "im gonna kill myself" both
      // register as threats against another person: the catch-all swallowed "it" and
      // "myself". A missed threat against a named individual is the price, and the
      // classifier is the half of the system that covers names.
      "first_person_threat",
      R`\b(i'?m|im|i\s+am)\s+(going\s+to|gonna|gna)\s+` +
        R`(kill|batter|stab|shoot|jump|smash|end)\s+` +
        R`(you|him|her|them|us|that\s+\w+)\b`,
    ],
    [
      "will_hurt_you",
      R`\bi'?ll\s+(kill|batter|stab|shoot|jump|smash|hurt|beat)\s+(you|him|her|them)\b`,
    ],
    [
      // `'?ll` sits beside `'?d` because every other future form already worked ('d,
      // would, will, was going to) and only the `'ll` contraction did not — so "he said
      // he'd batter me" floored at T3 and "he says he'll batter me" floored at nothing.
      // Found on day 7 by a seeded conversation written in the phrasing a student would
      // actually use. Same shape as the day 5 gap in `first_person_cutting`.
      //
      // Keep comments ABOVE the name, never between the concatenated R`` chunks: the
      // Python-side source comparison parses this shape and a mid-expression comment
      // silently truncates the regex it extracts.
      "reported_threat_against_student",
      R`\b(he|she|they|\w+)\s+(said|says|told\s+me)\s+` +
        R`(that\s+)?(he|she|they)?\s*('?d|'?ll|\s+would|\s+was\s+going\s+to|` +
        R`\s+is\s+going\s+to|\s+will)\s+` +
        R`(kill|batter|stab|shoot|jump|hurt|beat)\s+me\b`,
    ],
    ["threatened_to", R`\bthreaten(ed|ing)?\s+to\s+(kill|batter|stab|shoot|hurt|beat|jump)\b`],
    [
      // Told to kill yourself. Severe harassment, and the reason the matching attribution
      // regex also suppresses the suicidal_ideation banks: this is not the student's own
      // intent, so it must not trigger a T4 break-glass on its own.
      "told_target_to_kill_themselves",
      R`\b(told|telling|tells|said|saying|says|keep\s+telling)\s+` +
        R`(me|him|her|them)\s+(that\s+)?(i|he|she|they)?\s*(should\s+)?(to\s+)?` +
        R`(go\s+)?(kill\s+(my|your|him|her|them)\s?self|kys|just\s+die|` +
        R`un\s?alive\s+(my|your)\s?self)\b`,
    ],
    ["kys_abbreviation", R`\bkys\b`],
    [
      "wait_until_i_see_you",
      R`\bwait\s+(til|till|until)\s+i\s+(see|catch|find|get)\s+(you|him|her|them)\b`,
    ],
    ["youre_dead", R`\byou'?re\s+dead\b`],
  ],
  [Severity.MODERATE]: [
    // "me" is in every target list here, and it is not an afterthought. These patterns
    // were first written from the perpetrator's point of view ("make you pay"), which
    // misses the direction this product actually receives: a victim reporting what was
    // said to them ("he says he'll make me pay"). Two synthetic conversations scored zero.
    ["beat_you_up", R`\b(beat|batter|jump|do)\s+(you|him|her|them|me)\s+up\b`],
    ["coming_for_you", R`\b(coming|going)\s+(to\s+)?(get|find)\s+(you|him|her|them|me)\b`],
    ["make_you_pay", R`\bmake\s+(you|him|her|them|me)\s+(pay|regret\s+it|sorry)\b`],
    [
      "group_planning_violence",
      R`\bthey'?re\s+(all\s+)?(waiting|planning)\s+(for\s+me|to\s+get\s+me)\b`,
    ],
  ],
  [Severity.WEAK]: [
    ["fight_talk", R`\b(fight|scrap)\s+(you|him|her|them)\b`],
    ["dead_meat", R`\b(you|he|she|they)'?re\s+(gonna\s+)?get\s+it\b`],
  ],
};

const WEAPON_MENTION: Bank = {
  [Severity.STRONG]: [
    [
      "weapon_being_carried",
      R`\b(bring|brings|bringing|brought|carry|carrying|carried|got|has|have|had|` +
        R`pulled|showed|waving)\s+(a\s+|the\s+|his\s+|her\s+|their\s+)?` +
        R`(knife|knives|blade|machete|gun|pistol|firearm|shank|hammer|bat)\b`,
    ],
    [
      "weapon_at_school",
      R`\b(knife|knives|blade|machete|gun|pistol|firearm|shank)\b` +
        R`.{0,30}\b(school|class|lesson|playground|gates|bus)\b`,
    ],
  ],
  [Severity.MODERATE]: [
    [
      "weapon_attributed_to_person",
      R`\b(he|she|they|his|her|their|someone)\s+\w{0,12}\s*` +
        R`(knife|knives|blade|machete|gun|pistol|shank)\b`,
    ],
  ],
  [Severity.WEAK]: [
    [
      "bare_weapon_noun",
      R`\b(knife|knives|blade|machete|gun|pistol|firearm|shank|weapon|weapons)\b`,
    ],
  ],
};

/**
 * Never floors on its own; see `taxonomy.gateFloor`. Single severity by design, because
 * "tonight" is not more imminent than "after school" in any way we can measure.
 */
const IMMINENT_TIME_MARKER: Bank = {
  [Severity.MODERATE]: [
    [
      "imminent_window",
      R`\b(tonight|to\s?night|today|tomorrow|this\s+(afternoon|evening|morning|` +
        R`break|lunch|weekend)|after\s+school|before\s+school|at\s+lunch|` +
        R`next\s+(period|lesson)|in\s+an?\s+(hour|minute|bit)|right\s+now|` +
        R`on\s+my\s+way\s+home|when\s+i\s+get\s+home|any\s+minute)\b`,
    ],
  ],
};

export const PATTERNS: Readonly<Record<GateCategory, Bank>> = {
  [GateCategory.SELF_HARM_INTENT]: SELF_HARM_INTENT,
  [GateCategory.SUICIDAL_IDEATION]: SUICIDAL_IDEATION,
  [GateCategory.ABUSE_DISCLOSURE]: ABUSE_DISCLOSURE,
  [GateCategory.THREAT_OF_VIOLENCE]: THREAT_OF_VIOLENCE,
  [GateCategory.WEAPON_MENTION]: WEAPON_MENTION,
  [GateCategory.IMMINENT_TIME_MARKER]: IMMINENT_TIME_MARKER,
};

// ---------------------------------------------------------------------------------------
// Suppressors
// ---------------------------------------------------------------------------------------
//
// A hit is dropped when its span sits INSIDE a suppressor's span, so every suppressor must
// span the trigger phrase it is cancelling. Test the containment, not just the match.

const SELF_HARM_SUPPRESSORS: readonly PatternEntry[] = [
  [
    // `\s*` not `\s+` after the pronoun: the contraction in "i'm not going to" leaves no
    // space between "i" and "'m", and requiring one made this suppressor silently dead for
    // the single most common way a student reassures you.
    "negated_self_harm",
    R`\bi\s*(would\s+never|will\s+never|'?m\s+not\s+going\s+to|` +
      R`am\s+not\s+going\s+to|don'?t\s+want\s+to|never)\s+` +
      R`(cut|hurt|harm|burn)\s+myself\b`,
  ],
  [
    "recovery_framing",
    R`\bi\s+(stopped|quit|haven'?t|have\s+not|used\s+to)\s+` +
      R`\w{0,12}\s*(cut|cutting|self[\s\-]?harm(ing|ed)?|hurt\s+myself)\b`,
  ],
  [
    "topic_not_disclosure",
    R`\b(book|novel|film|movie|show|song|documentary|essay|assignment|project|` +
      R`article|poem|presentation|lesson|talk|website|charity)\s+` +
      R`(about|on|for)\s+\w{0,12}\s*self[\s\-]?harm(ing)?\b`,
  ],
  [
    "support_service_name",
    R`\bself[\s\-]?harm\s+` +
      R`(prevention|awareness|support|helpline|hotline|charity|week|campaign|service)\b`,
  ],
];

const SUICIDE_SUPPRESSORS: readonly PatternEntry[] = [
  [
    "negated_ideation",
    R`\bi\s*(would\s+never|will\s+never|'?m\s+not\s+going\s+to|` +
      R`am\s+not\s+going\s+to|never\s+said\s+i'?d|don'?t\s+want\s+to)\s+` +
      R`(kill\s+my\s?self|die|end\s+it(\s+all)?|end\s+my\s+life|` +
      R`un\s?alive\s+my\s?self)\b`,
  ],
  [
    "reassurance",
    R`\b(i'?m|im)\s+not\s+(suicidal|going\s+to\s+do\s+anything|` +
      R`going\s+to\s+hurt\s+my\s?self)\b`,
  ],
  [
    // The student is reporting harassment, not disclosing intent. The same regex is a
    // STRONG threat_of_violence pattern, so the case still floors at T3.
    "told_by_someone_else",
    R`\b(told|telling|tells|said|saying|says|keep\s+telling)\s+` +
      R`(me|him|her|them)\s+(that\s+)?(i|he|she|they)?\s*(should\s+)?(to\s+)?` +
      R`(go\s+)?(kill\s+(my|your|him|her|them)\s?self|kys|just\s+die|` +
      R`un\s?alive\s+(my|your)\s?self)\b`,
  ],
  [
    "topic_not_disclosure",
    R`\b(book|novel|film|movie|show|song|lyrics|documentary|essay|assignment|` +
      R`project|article|poem|presentation|lesson|talk|website|charity|news)\s+` +
      R`(about|on|for)\s+\w{0,12}\s*(suicide|suicidal|killing\s+(your|him|her)\s?self)\b`,
  ],
  [
    "support_service_name",
    R`\bsuicid(e|al)\s+` +
      R`(prevention|awareness|support|helpline|hotline|charity|week|campaign|` +
      R`service|rates?|statistics)\b`,
  ],
  [
    "hyperbole_killing_me",
    R`\b(homework|revision|exam|exams|essay|coursework|training|practice|this|that|` +
      R`my\s+\w+|the\s+\w+|it)\s+(is|are|'?s|'?re|was|were)\s+` +
      R`(literally\s+|actually\s+|so\s+)?killing\s+me\b`,
  ],
  ["kill_for", R`\b(could|would)\s+kill\s+for\s+(a|an|some)\b`],
  ["distance_kms", R`\b\d+\s?kms?\b`],
  [
    // Must span back to the pronoun, because that is where the ideation match starts.
    "die_of_embarrassment",
    R`\bi\s+(just\s+|literally\s+|actually\s+|still\s+)*(want|wanna)\s+to\s+die\s+` +
      R`(of|from)\s+(embarrassment|shame|cringe|laughing|laughter|boredom)\b`,
  ],
  ["dying_idiom", R`\b(dying|dead)\s+(of|from)\s+(laughter|boredom|embarrassment)\b`],
];

const ABUSE_SUPPRESSORS: readonly PatternEntry[] = [
  [
    "fictional_or_historical",
    R`\b(in\s+the\s+(book|film|movie|show|story)|the\s+character|we\s+read\s+about)\b` +
      R`.{0,60}\b(hit|beat|hurt)\s+me\b`,
  ],
  [
    "play_fighting",
    R`\b(play|playing|joking|messing|pretend)\s+\w{0,10}\s*` +
      R`(hit|hits|fight|fighting)\s+me\b`,
  ],
];

const THREAT_SUPPRESSORS: readonly PatternEntry[] = [
  [
    "gaming_context",
    R`\b(in\s+(the\s+)?game|on\s+(fortnite|minecraft|roblox|cod|fifa)|` +
      R`my\s+(character|team)|respawn|final\s+boss|the\s+boss)\b` +
      R`.{0,40}\b(kill|shoot|stab|batter)\s+(you|him|her|them)\b`,
  ],
  [
    // Must span the pronoun too, or containment fails: the threat pattern's match starts
    // at "i'm", so a suppressor starting at "gonna" sits inside it rather than around it
    // and cancels nothing.
    "sports_or_game_idiom",
    R`\b(i'?m\s+|im\s+|i\s+am\s+|we'?re\s+|we\s+are\s+)?` +
      R`(gonna|going\s+to|gna)\s+(smash|batter|destroy|beat|thrash|end)\s+` +
      R`(you|him|her|them)\s+(at|in|on)\s+\w+\b`,
  ],
];

const WEAPON_SUPPRESSORS: readonly PatternEntry[] = [
  [
    "kitchen_or_craft_context",
    R`\b(kitchen|butter|bread|cooking|food\s?tech|craft|carving|penknife|` +
      R`scout|camping|dinner)\s+\w{0,8}\s*(knife|knives|blade)\b`,
  ],
  [
    "gaming_context",
    R`\b(in\s+(the\s+)?game|fortnite|minecraft|roblox|cod|warzone|nerf|water)\s+` +
      R`\w{0,10}\s*(gun|knife|blade)\b`,
  ],
  ["figurative_gun", R`\b(jumped\s+the\s+gun|gun\s+it|glue\s+gun|nerf\s+gun)\b`],
];

export const SUPPRESSORS: Readonly<Record<GateCategory, readonly PatternEntry[]>> = {
  [GateCategory.SELF_HARM_INTENT]: SELF_HARM_SUPPRESSORS,
  [GateCategory.SUICIDAL_IDEATION]: SUICIDE_SUPPRESSORS,
  [GateCategory.ABUSE_DISCLOSURE]: ABUSE_SUPPRESSORS,
  [GateCategory.THREAT_OF_VIOLENCE]: THREAT_SUPPRESSORS,
  [GateCategory.WEAPON_MENTION]: WEAPON_SUPPRESSORS,
  [GateCategory.IMMINENT_TIME_MARKER]: [],
};

// ---------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------
//
// Compiled once at module load. The gate sits in front of every student turn in a live
// chat, so recompiling per call would put regex compilation on the latency path for free.
//
// Flags mirror Python's `re.IGNORECASE | re.DOTALL`: `i` and `s`. `g` is required by
// `matchAll`. A `g` regex carries mutable `lastIndex`, so these compiled objects are only
// ever used through `matchAll`, which clones internally rather than mutating.

const FLAGS = "gis";

export interface CompiledPattern {
  readonly name: string;
  readonly rx: RegExp;
}

function compile(entries: readonly PatternEntry[]): CompiledPattern[] {
  return entries.map(([name, source]) => ({ name, rx: new RegExp(source, FLAGS) }));
}

export const COMPILED_PATTERNS: Readonly<
  Record<GateCategory, Partial<Record<Severity, CompiledPattern[]>>>
> = Object.fromEntries(
  GATE_CATEGORY_ORDER.map((category) => [
    category,
    Object.fromEntries(
      SEVERITY_ORDER.map((severity) => [
        severity,
        compile(PATTERNS[category][severity] ?? []),
      ]),
    ),
  ]),
) as Readonly<Record<GateCategory, Partial<Record<Severity, CompiledPattern[]>>>>;

export const COMPILED_SUPPRESSORS: Readonly<Record<GateCategory, CompiledPattern[]>> =
  Object.fromEntries(
    GATE_CATEGORY_ORDER.map((category) => [category, compile(SUPPRESSORS[category])]),
  ) as Readonly<Record<GateCategory, CompiledPattern[]>>;

/** Bank sizes, for the log entry and for `docs/results.md`. */
export function patternCount(): Record<string, number> {
  return Object.fromEntries(
    GATE_CATEGORY_ORDER.map((category) => [
      category,
      SEVERITY_ORDER.reduce(
        (n, severity) => n + (PATTERNS[category][severity]?.length ?? 0),
        0,
      ),
    ]),
  );
}
