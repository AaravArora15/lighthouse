/**
 * Sessions: minting, resolving, revoking.
 *
 * Deliberately free of `next/headers` and of any request context, so the whole of it runs
 * under vitest against `createMemoryStore()` with no server and no database. The cookie
 * glue lives in `current.ts`, which is a thin wrapper over these functions — the rule
 * being that anything with a decision in it stays on this side of the line.
 *
 * ## An opaque random token, not a JWT
 *
 * A JWT is a bearer credential that stays valid until it expires, and there is no
 * mechanism to take it back. This system needs the opposite property: a counsellor who
 * leaves, or an account that turns out to be compromised, must lose access *now*, and the
 * material they had access to is children's disclosures. So the token is 32 random bytes
 * carrying no claims, every request resolves it against the store, and revocation is a
 * single UPDATE that takes effect on the next request.
 *
 * The cost is a database read per request. At a school's traffic that is not a real cost,
 * and paying it is what makes "sign this person out" a true statement.
 *
 * ## The store holds a hash, never the token
 *
 * `sha256` rather than scrypt, and that is correct rather than a shortcut: the token is
 * 256 bits of CSPRNG output, so there is no dictionary to attack and no reason to make
 * lookup slow. Stretching is for secrets humans chose.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { SESSION_TTL_HOURS } from "@/lib/config";
import type { CounsellorRole, Store } from "@/lib/store";

export { SESSION_TTL_HOURS };

export const SESSION_COOKIE = "lighthouse_session";

/** The authenticated actor, as every downstream module wants it. */
export interface Principal {
  counsellorId: string;
  email: string;
  displayName: string;
  role: CounsellorRole;
}

export type SignInResult =
  | { ok: true; token: string; expiresAt: string; principal: Principal }
  | { ok: false; error: string };

/**
 * One message for every failure mode.
 *
 * Distinguishing "no such account" from "wrong password" turns the login form into an
 * oracle for which staff members use this system, which is a fact about a school's
 * safeguarding arrangements. A disabled account gets the same sentence for the same reason.
 */
const SIGN_IN_FAILED =
  "That email and password do not match an active account. If you have just been set up, " +
  "check with your safeguarding lead.";

/**
 * A real hash to compare against when the email is unknown, so the response takes the same
 * time either way. Computed once at module load rather than per request.
 */
const DUMMY_HASH_PROMISE = hashPassword("not-a-real-password-placeholder");

export async function signIn(
  store: Store,
  input: { email: string; password: string; now?: Date },
): Promise<SignInResult> {
  const now = input.now ?? new Date();
  const counsellor = await store.counsellorByEmail(input.email);

  if (!counsellor) {
    await verifyPassword(input.password, await DUMMY_HASH_PROMISE);
    return { ok: false, error: SIGN_IN_FAILED };
  }

  const correct = await verifyPassword(input.password, counsellor.passwordHash);
  if (!correct) return { ok: false, error: SIGN_IN_FAILED };

  // Checked after the password, not before. Short-circuiting on `active` would make a
  // disabled account answer faster than a live one with a wrong password, which is the
  // timing oracle the single error message exists to close.
  if (!counsellor.active) return { ok: false, error: SIGN_IN_FAILED };

  // The one moment the plaintext exists. If the stored hash predates a cost increase,
  // upgrade it here or it never gets upgraded.
  if (needsRehash(counsellor.passwordHash)) {
    await store.updatePasswordHash(counsellor.id, await hashPassword(input.password));
  }

  const token = mintToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000).toISOString();

  await store.createSession({
    counsellorId: counsellor.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  await store.touchCounsellor(counsellor.id, now.toISOString());

  return {
    ok: true,
    token,
    expiresAt,
    principal: {
      counsellorId: counsellor.id,
      email: counsellor.email,
      displayName: counsellor.displayName,
      role: counsellor.role,
    },
  };
}

/**
 * Resolve a token to a principal, or `null`.
 *
 * Four independent reasons to refuse, each checked every request: unknown token, revoked
 * session, expired session, deactivated account. The last one is why the counsellor row is
 * re-read rather than cached in the token — disabling an account has to bite immediately.
 */
export async function resolveSession(
  store: Store,
  token: string | undefined | null,
  now: Date = new Date(),
): Promise<Principal | null> {
  if (!token) return null;

  const session = await store.sessionByTokenHash(hashToken(token));
  if (!session) return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() <= now.getTime()) return null;

  const counsellor = await store.counsellorById(session.counsellorId);
  if (!counsellor || !counsellor.active) return null;

  return {
    counsellorId: counsellor.id,
    email: counsellor.email,
    displayName: counsellor.displayName,
    role: counsellor.role,
  };
}

export async function signOut(
  store: Store,
  token: string | undefined | null,
  now: Date = new Date(),
): Promise<void> {
  if (!token) return;
  await store.revokeSession(hashToken(token), now.toISOString());
}

/** Disable an account and end every live session it has. Used by the lead, and by scripts. */
export async function revokeAllSessions(
  store: Store,
  counsellorId: string,
  now: Date = new Date(),
): Promise<void> {
  await store.revokeSessionsFor(counsellorId, now.toISOString());
}

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Constant-time token comparison, for any caller that needs to match two tokens. */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
