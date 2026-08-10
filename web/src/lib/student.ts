/**
 * What a student is told about their own case.
 *
 * `docs/context.md` §11 promises "audit log of every counsellor access, **visible to the
 * student**" and "consent screen a 12-year-old can read". Both were unbuilt until now,
 * while the counsellor's screen rendered the words *"Shown to you because it is shown to
 * the student"* over a log the student had no way to reach. This module is that promise,
 * finally kept.
 *
 * ## The tier is never shown to the student
 *
 * The single most important decision in this file. A counsellor sees `T4 — risk to life`.
 * A thirteen-year-old must not, for two reasons:
 *
 * 1. **It is not true in the way they would read it.** A tier is a routing decision made
 *    partly by a regex bank. Telling a child a computer has classified them as at risk to
 *    life is a clinical-sounding statement this product has no standing to make, and
 *    CLAUDE.md is explicit that Lighthouse is a listening and routing tool, not therapy.
 * 2. **It could do harm.** Showing someone in distress a machine-generated severity label
 *    about themselves is not a neutral act, and there is no one on the other end of this
 *    page to talk them through it.
 *
 * So a student is told **what happens next**, which is the part that affects them and the
 * part we can actually stand behind: whether someone will get in touch, roughly when, and
 * when the conversation gets deleted.
 *
 * ## The URL is the credential
 *
 * There is no account, by design. Anyone holding the link can read the case, which is why
 * `newCaseId` is 128 bits. The tradeoff is stated in `docs/privacy.md` rather than hidden:
 * a student who shares their link has shared their conversation, exactly as if they had
 * forwarded a screenshot.
 */

import type { EscalationCard } from "@/lib/cards";
import * as config from "@/lib/config";
import { ESCALATED_TIERS, QUEUED_TIERS, Tier } from "@/lib/taxonomy";

export interface StudentStatus {
  /** One sentence on what happens next. Never a tier, never a severity word. */
  headline: string;
  /** A little more, if there is anything honest to add. */
  detail: string | null;
  /** Whether a counsellor is expected to make contact at all. */
  someoneWillRead: boolean;
}

/**
 * Plain-language status.
 *
 * Deliberately vague about *how* the decision was reached and precise about *what happens*.
 * A student cares whether an adult is going to get in touch and when their words disappear.
 * They do not need to know which regex matched.
 */
export function statusFor(card: EscalationCard): StudentStatus {
  if (card.tier === Tier.T4) {
    return {
      headline: "Someone will get in touch with you as soon as possible.",
      detail:
        "A counsellor at your school has been told about this conversation and it is at " +
        "the top of their list. If you need to talk to someone right now, the numbers " +
        "below are free and open all day and night.",
      someoneWillRead: true,
    };
  }

  if (card.tier === Tier.T3) {
    return {
      headline: "A counsellor will get in touch, usually within a day.",
      detail:
        "Someone at your school has your conversation and will read it. You do not have " +
        "to do anything else.",
      someoneWillRead: true,
    };
  }

  if (QUEUED_TIERS.has(card.tier)) {
    return {
      headline: "A counsellor has your conversation and will read it.",
      detail:
        "It is in their list rather than at the top of it, so this might take a few days.",
      someoneWillRead: true,
    };
  }

  return {
    headline: "Nobody has been asked to follow this up.",
    detail:
      "Nothing here looked like something a counsellor needed to act on. That is not a " +
      "judgement about whether it matters to you. You can keep talking any time, and if " +
      "things change, say so and it will be looked at again.",
    someoneWillRead: false,
  };
}

/** When this conversation gets deleted, in words rather than a policy reference. */
export function retentionFor(card: EscalationCard): string {
  if (card.retentionExpiresAt === null) {
    return ESCALATED_TIERS.has(card.tier)
      ? "Because a counsellor is following this up, your conversation is kept as part of " +
          "their record and is not deleted automatically. You can ask your school what " +
          "happens to it."
      : "This conversation does not have a deletion date set yet.";
  }
  const when = new Date(card.retentionExpiresAt);
  return (
    `Your conversation is deleted on ${when.toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}, ${config.RETENTION_DAYS_NON_ESCALATED} days after it started. After that it is ` +
    "gone and nobody can read it, including us."
  );
}

/**
 * The two sentences from §11, shown before a student types anything.
 *
 * Kept here rather than inline in the page so the promise has one home and the tests can
 * assert on it. Deliberately short: a wall of policy text at the top of a crisis chat is
 * not consent, it is an obstacle, and it gets scrolled past by exactly the people it was
 * meant to protect.
 */
export const CONSENT_LINES = [
  "Nobody here knows who you are. You do not have to give your name.",
  "If something you write looks like you might not be safe, a counsellor at your school " +
    "reads it, and you can see exactly who opened it.",
] as const;

/**
 * Placeholders the student will see in their own transcript, explained.
 *
 * Showing a student their own `[phone]` marker is the clearest demonstration available
 * that redaction is real rather than a claim in a README, so the receipt page shows the
 * stored text rather than what they typed, and says why.
 */
export const REDACTION_NOTE =
  "Anything that could identify you or someone else, like a phone number or an address, " +
  "was taken out before your conversation was saved. That is why you might see things " +
  "like [phone] below. The counsellor sees the same thing you do.";
