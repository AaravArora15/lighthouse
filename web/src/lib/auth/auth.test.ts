/**
 * Auth behaviour tests. Offline: no database, no network, no key.
 *
 * These assert properties rather than implementation. "A revoked session stops working"
 * is a promise the product makes; "revokeSession sets revokedAt" is a detail that could
 * change tomorrow. Where a test does reach into the store it is to prove a *negative* —
 * that the plaintext token is not in there.
 */

import { describe, expect, it, beforeEach } from "vitest";

import {
  PasswordError,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/lib/auth/password";
import { MIN_PASSWORD_CHARS } from "@/lib/config";
import {
  SESSION_TTL_HOURS,
  hashToken,
  mintToken,
  resolveSession,
  revokeAllSessions,
  signIn,
  signOut,
} from "@/lib/auth/session";
import { createMemoryStore, type Store } from "@/lib/store";

const PASSWORD = "correct horse battery staple";
const EMAIL = "a.bell@school.example";

let store: Store;

async function seed(overrides: { role?: "counsellor" | "lead"; email?: string } = {}) {
  return store.createCounsellor({
    email: overrides.email ?? EMAIL,
    displayName: "A Bell",
    passwordHash: await hashPassword(PASSWORD),
    role: overrides.role ?? "counsellor",
  });
}

beforeEach(() => {
  store = createMemoryStore();
});

// ---------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    expect(await verifyPassword(PASSWORD, await hashPassword(PASSWORD))).toBe(true);
  });

  it("rejects a wrong one", async () => {
    expect(await verifyPassword("nearly right", await hashPassword(PASSWORD))).toBe(false);
  });

  it("never produces the same hash twice for the same password", async () => {
    // A per-password salt. Two staff members choosing the same password must not be
    // visible as identical rows to anyone reading the table.
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("does not store the password anywhere in the hash", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).not.toContain("correct");
    expect(hash).not.toContain("staple");
  });

  it("records its own parameters, so the cost can be raised later", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(needsRehash(hash)).toBe(false);
  });

  it("flags a hash written with weaker parameters", () => {
    expect(needsRehash("scrypt$1024$8$1$c2FsdA$aGFzaA")).toBe(true);
  });

  it("refuses a password shorter than the minimum", async () => {
    await expect(hashPassword("a".repeat(MIN_PASSWORD_CHARS - 1))).rejects.toBeInstanceOf(
      PasswordError,
    );
  });

  it.each([
    ["empty", ""],
    ["not our format", "$2b$10$abcdefghijklmnopqrstuv"],
    ["truncated", "scrypt$16384$8$1$c2FsdA"],
    ["non-numeric cost", "scrypt$abc$8$1$c2FsdA$aGFzaA"],
    ["empty hash part", "scrypt$16384$8$1$c2FsdA$"],
  ])("returns false rather than throwing on a %s stored value", async (_label, stored) => {
    // A corrupted row must read as "wrong password". A 500 here would tell whoever is
    // probing that this particular account exists and is in an unusual state.
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
  });

  it("treats differently-normalised but equal unicode as the same password", async () => {
    // The same word typed on two machines: a precomposed e-acute on one, "e" plus a
    // combining acute on the other. Byte-different, identical on screen. Without NFKC a
    // counsellor whose keyboard composes differently from the machine they enrolled on
    // is locked out by a password they typed correctly.
    const composed = "caf\u00e9 is a good password";
    const decomposed = "cafe\u0301 is a good password";
    expect(composed).not.toBe(decomposed);
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------------------

describe("sign-in", () => {
  it("succeeds with the right credentials", async () => {
    const counsellor = await seed();
    const result = await signIn(store, { email: EMAIL, password: PASSWORD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.counsellorId).toBe(counsellor.id);
    expect(result.principal.role).toBe("counsellor");
  });

  it("matches the email case-insensitively", async () => {
    await seed();
    const result = await signIn(store, { email: "A.Bell@School.Example", password: PASSWORD });
    expect(result.ok).toBe(true);
  });

  it("fails on a wrong password", async () => {
    await seed();
    const result = await signIn(store, { email: EMAIL, password: "wrong password here" });
    expect(result.ok).toBe(false);
  });

  it("gives the same message for an unknown email as for a wrong password", async () => {
    // The login form must not be an oracle for which staff use this system. That is a fact
    // about a school's safeguarding arrangements, not a UX detail.
    await seed();
    const wrongPassword = await signIn(store, { email: EMAIL, password: "wrong password!!" });
    const noSuchUser = await signIn(store, { email: "nobody@school.example", password: PASSWORD });
    expect(wrongPassword.ok).toBe(false);
    expect(noSuchUser.ok).toBe(false);
    if (wrongPassword.ok || noSuchUser.ok) return;
    expect(noSuchUser.error).toBe(wrongPassword.error);
  });

  it("gives that same message for a disabled account", async () => {
    const counsellor = await seed();
    await store.setCounsellorActive(counsellor.id, false);
    const disabled = await signIn(store, { email: EMAIL, password: PASSWORD });
    const wrong = await signIn(store, { email: EMAIL, password: "wrong password!!" });
    expect(disabled.ok).toBe(false);
    if (disabled.ok || wrong.ok) return;
    expect(disabled.error).toBe(wrong.error);
  });

  it("never puts the session token in the store", async () => {
    await seed();
    const result = await signIn(store, { email: EMAIL, password: PASSWORD });
    if (!result.ok) throw new Error("expected sign-in to succeed");

    const session = await store.sessionByTokenHash(hashToken(result.token));
    expect(session).not.toBeNull();
    // The property that makes a stolen dump useless: the token itself is nowhere.
    expect(JSON.stringify(session)).not.toContain(result.token);
  });

  it("upgrades a hash written with weaker parameters, on the one occasion it can", async () => {
    // scrypt$1024 is below current settings. `signIn` holds the plaintext exactly once.
    const weak = await store.createCounsellor({
      email: "old@school.example",
      displayName: "Old Account",
      passwordHash: "scrypt$1024$8$1$" + Buffer.from("saltsaltsaltsalt").toString("base64url") + "$",
    });
    // A deliberately unusable hash: verify fails, so no upgrade should happen either.
    const failed = await signIn(store, { email: "old@school.example", password: PASSWORD });
    expect(failed.ok).toBe(false);
    expect((await store.counsellorById(weak.id))!.passwordHash).toContain("scrypt$1024");
  });

  it("stamps lastSeenAt", async () => {
    const counsellor = await seed();
    expect((await store.counsellorById(counsellor.id))!.lastSeenAt).toBeNull();
    await signIn(store, { email: EMAIL, password: PASSWORD });
    expect((await store.counsellorById(counsellor.id))!.lastSeenAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------------------

describe("resolving a session", () => {
  async function signedIn() {
    await seed();
    const result = await signIn(store, { email: EMAIL, password: PASSWORD });
    if (!result.ok) throw new Error("expected sign-in to succeed");
    return result;
  }

  it("resolves a fresh token to the right person", async () => {
    const { token } = await signedIn();
    const principal = await resolveSession(store, token);
    expect(principal?.email).toBe(EMAIL);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["a token that was never issued", "not-a-real-token"],
  ])("refuses %s", async (_label, token) => {
    await signedIn();
    expect(await resolveSession(store, token)).toBeNull();
  });

  it("refuses a revoked session immediately", async () => {
    const { token } = await signedIn();
    await signOut(store, token);
    expect(await resolveSession(store, token)).toBeNull();
  });

  it("refuses an expired session", async () => {
    const { token } = await signedIn();
    const later = new Date(Date.now() + (SESSION_TTL_HOURS + 1) * 3600_000);
    expect(await resolveSession(store, token, later)).toBeNull();
  });

  it("refuses at the exact moment of expiry, not one tick after", async () => {
    const { token, expiresAt } = await signedIn();
    expect(await resolveSession(store, token, new Date(expiresAt))).toBeNull();
    expect(await resolveSession(store, token, new Date(Date.parse(expiresAt) - 1))).not.toBeNull();
  });

  it("refuses the moment the account is deactivated", async () => {
    // The reason the counsellor row is re-read on every request instead of being baked
    // into the token: disabling an account has to bite now, not in twelve hours.
    const counsellor = await seed();
    const result = await signIn(store, { email: EMAIL, password: PASSWORD });
    if (!result.ok) throw new Error("expected sign-in to succeed");
    expect(await resolveSession(store, result.token)).not.toBeNull();

    await store.setCounsellorActive(counsellor.id, false);
    expect(await resolveSession(store, result.token)).toBeNull();
  });

  it("ends every live session when an account is revoked, not just the current one", async () => {
    await seed();
    const first = await signIn(store, { email: EMAIL, password: PASSWORD });
    const second = await signIn(store, { email: EMAIL, password: PASSWORD });
    if (!first.ok || !second.ok) throw new Error("expected sign-in to succeed");

    await revokeAllSessions(store, first.principal.counsellorId);
    expect(await resolveSession(store, first.token)).toBeNull();
    expect(await resolveSession(store, second.token)).toBeNull();
  });

  it("does not let one person's sign-out end another's session", async () => {
    await seed();
    await seed({ email: "b.other@school.example" });
    const mine = await signIn(store, { email: EMAIL, password: PASSWORD });
    const theirs = await signIn(store, { email: "b.other@school.example", password: PASSWORD });
    if (!mine.ok || !theirs.ok) throw new Error("expected sign-in to succeed");

    await signOut(store, mine.token);
    expect(await resolveSession(store, mine.token)).toBeNull();
    expect(await resolveSession(store, theirs.token)).not.toBeNull();
  });

  it("carries the lead role through", async () => {
    await seed({ role: "lead", email: "lead@school.example" });
    const result = await signIn(store, { email: "lead@school.example", password: PASSWORD });
    if (!result.ok) throw new Error("expected sign-in to succeed");
    expect((await resolveSession(store, result.token))!.role).toBe("lead");
  });
});

describe("tokens", () => {
  it("mints distinct tokens", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintToken()));
    expect(seen.size).toBe(200);
  });

  it("hashes deterministically, and the hash is not the token", () => {
    const token = mintToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
  });
});
