/**
 * The request-scoped half of auth: cookies, and the guard every protected surface calls.
 *
 * Kept separate from `session.ts` because this file cannot run under vitest — `cookies()`
 * needs a Next request context. Everything with a decision in it lives on the other side
 * of that line, so the untestable part is only plumbing.
 *
 * ## The guard is called by each page and route, not by a proxy
 *
 * Next's own guidance is that middleware (`proxy.ts` in 16) is for optimistic redirects
 * and must not be the authorisation check, and layouts do not re-render on client-side
 * navigation between their children. So `requireCounsellor()` is called at the top of
 * every protected page and route handler. There are five of them; a check that is easy to
 * forget on the sixth is exactly why it returns a principal the handler then needs, rather
 * than just a boolean it could ignore.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  Principal,
  SESSION_COOKIE,
  SESSION_TTL_HOURS,
  resolveSession,
  signOut,
} from "@/lib/auth/session";
import { store } from "@/lib/store";

/** The principal for this request, or `null`. Never redirects; for optional-auth surfaces. */
export async function currentCounsellor(): Promise<Principal | null> {
  const jar = await cookies();
  return resolveSession(await store(), jar.get(SESSION_COOKIE)?.value);
}

/**
 * The principal for this request, or a redirect to sign-in.
 *
 * `next` carries the path back so a counsellor who followed a link to a specific case
 * lands on that case after signing in, rather than on the queue with no idea which one
 * they were opening. Only ever a path — see `safeNext`.
 */
export async function requireCounsellor(next?: string): Promise<Principal> {
  const principal = await currentCounsellor();
  if (principal) return principal;
  const target = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
  redirect(target);
}

/**
 * The principal, or a 401 JSON response. For route handlers, where a redirect would be
 * answered by `fetch` following it and the client seeing an HTML login page as its API
 * response — a confusing failure that looks like a parse error rather than a sign-out.
 */
export async function requireCounsellorApi(): Promise<
  { ok: true; principal: Principal } | { ok: false; response: Response }
> {
  const principal = await currentCounsellor();
  if (principal) return { ok: true, principal };
  return {
    ok: false,
    response: Response.json(
      { error: "Not signed in, or your session has expired. Sign in again." },
      { status: 401 },
    ),
  };
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Not readable from JavaScript, not sent cross-site, and HTTPS-only off localhost.
    // A session on this system reads children's disclosures; the defaults are not enough.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_HOURS * 3600,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  // Revoke server-side first. Deleting only the cookie would leave a live session behind
  // that anyone holding a copy of the token could keep using.
  await signOut(await store(), token);
  jar.delete(SESSION_COOKIE);
}

/**
 * Only same-origin paths survive this.
 *
 * `?next=https://evil.example` on a login form is an open redirect, and one on a
 * safeguarding tool is a credible phishing hop: the URL a counsellor sees is the real one
 * right up until they have signed in. Protocol-relative `//host` is rejected too, since it
 * is a URL that does not look like one.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}
