/**
 * The PII map: the only place a student's real words about real people survive.
 *
 * `redact.ts` finds the identifying spans and replaces them with placeholders. This
 * module encrypts what came out, so the database holds a redacted transcript and a column
 * of ciphertext, and nothing else.
 *
 * ## The property this is for
 *
 * **A database dump alone must not de-anonymise a child.** That is the whole design.
 * Whoever ends up holding a copy of the `pii_map` table — a backup, a subpoena, a
 * breach — gets AES-256-GCM ciphertext and no way to read it. Unsealing needs
 * `LIGHTHOUSE_PII_KEY`, which in a real deployment lives in a secret store and
 * deliberately **not** beside `DATABASE_URL`: holding both is equivalent to holding
 * plaintext, so separating them is the control.
 *
 * ## Why GCM and not CBC
 *
 * GCM is authenticated. Tampering with a ciphertext produces a decryption *failure*
 * rather than different plaintext. A counsellor console that could be made to display an
 * attacker-chosen name by flipping bits in a database row would be worse than one that
 * shows nothing, and CBC without a separate MAC allows exactly that.
 *
 * ## Unsealing is an event, not an accessor
 *
 * `unseal` demands a reason and a counsellor id, and returns the plaintext alongside an
 * audit record the caller is obliged to persist. There is deliberately no
 * `decrypt(ciphertext)` convenience function — a name that can be read without leaving a
 * trace is a promise this project has already made it cannot keep.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32; // AES-256

export class SealError extends Error {}

/**
 * Key material, read lazily so importing this module never throws at build time.
 *
 * A missing key is a hard failure rather than a fallback. There is no "unencrypted mode":
 * a deployment that silently stored plaintext because an env var was unset is precisely
 * the failure this file exists to prevent, and it would look identical to working.
 */
function key(): Buffer {
  const raw = process.env.LIGHTHOUSE_PII_KEY;
  if (!raw) {
    throw new SealError(
      "LIGHTHOUSE_PII_KEY is not set. Refusing to store or read identifying spans. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new SealError(
      `LIGHTHOUSE_PII_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}. ` +
        "It should be base64 of 32 random bytes.",
    );
  }
  return buf;
}

export function hasKey(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt one identifying span.
 *
 * Returns a single self-describing string: `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 * Versioned so a future algorithm change can be rolled out without a migration that has
 * to guess how each row was written.
 *
 * A fresh random IV per call means the same name sealed twice yields different
 * ciphertext. That is required, not incidental: deterministic ciphertext would let anyone
 * with the table see that two conversations mention the same person, which is exactly the
 * inference the encryption is meant to prevent. Cross-conversation matching is done with
 * keyed HMAC pseudonyms in the clustering layer instead, where it is intentional.
 */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

export interface UnsealRequest {
  ciphertext: string;
  counsellorId: string;
  /** Why this counsellor needs the name. Recorded verbatim; must be substantive. */
  reason: string;
  caseId: string;
}

export interface UnsealResult {
  plaintext: string;
  /** Persist this. The student is entitled to see it (`docs/context.md` §11). */
  audit: {
    caseId: string;
    counsellorId: string;
    action: "unsealed_pii";
    reason: string;
    at: string;
  };
}

const MIN_REASON_CHARS = 20;

/**
 * Decrypt one span, and produce the audit record that must accompany it.
 *
 * The reason threshold is higher than the tier-override one (20 characters against 10)
 * because this is a bigger act: an override changes a queue position, this lifts a
 * child's anonymity. It should feel heavier at the point of use.
 */
export function unseal(request: UnsealRequest): UnsealResult {
  const reason = request.reason.trim();
  if (reason.length < MIN_REASON_CHARS) {
    throw new SealError(
      `Unsealing identifying information requires a reason of at least ${MIN_REASON_CHARS} ` +
        "characters. This is recorded and the student can see it.",
    );
  }
  if (!request.counsellorId) {
    throw new SealError("Unsealing requires an identified counsellor.");
  }

  const parts = request.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new SealError("Malformed sealed value.");
  }
  const [, ivPart, tagPart, bodyPart] = parts;

  let plaintext: string;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM authentication failed: the row was tampered with, or the key has been rotated.
    // Both mean "do not show anything", and the message deliberately does not say which,
    // because that distinction is only useful to someone probing the store.
    throw new SealError(
      "Could not read this value. It may have been altered, or the encryption key may " +
        "have changed. Nothing has been disclosed.",
    );
  }

  return {
    plaintext,
    audit: {
      caseId: request.caseId,
      counsellorId: request.counsellorId,
      action: "unsealed_pii",
      reason,
      at: new Date().toISOString(),
    },
  };
}

/**
 * Constant-time equality, for comparing a sealed value against a known one without
 * leaking position information through timing. Used by tests and by any future
 * "is this the same sealed span" check.
 */
export function sealedEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
