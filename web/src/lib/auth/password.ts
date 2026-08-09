/**
 * Password hashing, on Node's built-in scrypt.
 *
 * ## Why scrypt and not bcrypt or argon2
 *
 * Both of those are native addons. This deploys to serverless, where a native binary is a
 * build-time hazard for a project that has one week and no ops budget, and the failure
 * mode is a deploy that works locally and 500s in production. `node:crypto` ships scrypt,
 * which is memory-hard, is the algorithm OWASP lists as an acceptable choice, and cannot
 * fail to install. A general-purpose hash (SHA-256, even salted) would not be acceptable
 * here: it is fast, and fast is the whole problem.
 *
 * ## The stored format carries its own parameters
 *
 *     scrypt$16384$8$1$<salt base64url>$<hash base64url>
 *
 * Self-describing, so the cost can be raised later without a migration that has to guess
 * how each row was written. `needsRehash` reports when a stored row is below current
 * settings and `verify` is the natural place to act on it: the plaintext is in hand
 * exactly once, at login.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { MIN_PASSWORD_CHARS } from "@/lib/config";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** ~16 MB and roughly 100 ms per hash on the target hardware. OWASP's floor is N=2^14. */
const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** scrypt needs 128*N*r bytes; Node's default cap of 32 MB leaves no headroom at N=16384. */
const MAXMEM = 128 * N * R * 2;

export class PasswordError extends Error {}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_CHARS) {
    throw new PasswordError(
      `A password must be at least ${MIN_PASSWORD_CHARS} characters. Length is the only ` +
        "rule: a long phrase you can remember beats a short one you have to write down.",
    );
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Check a password against a stored hash.
 *
 * Returns `false` for a malformed or unknown-algorithm row rather than throwing. A
 * corrupted row must read as "wrong password", not as a 500 that tells whoever is probing
 * that this particular account exists and is in an unusual state.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nStr, rStr, pStr, saltPart, hashPart] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const expected = Buffer.from(hashPart, "base64url");
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(
      password.normalize("NFKC"),
      Buffer.from(saltPart, "base64url"),
      expected.length,
      { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) },
    );
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a stored hash was written with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}
