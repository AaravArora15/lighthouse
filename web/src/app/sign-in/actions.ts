"use server";

/**
 * Sign-in, as a Server Action.
 *
 * A Server Action rather than a route handler for one reason that matters here: the
 * password never becomes part of a URL, a client-side fetch body written by our own code,
 * or anything a browser extension sees as JSON. The form posts, the function runs on the
 * server, and the only thing that comes back is a cookie or an error string.
 *
 * All the decisions live in `lib/auth/session.ts`, which is testable offline. This file is
 * the form-to-function adapter and nothing else.
 */

import { redirect } from "next/navigation";

import { safeNext, setSessionCookie } from "@/lib/auth/current";
import { signIn } from "@/lib/auth/session";
import { store } from "@/lib/store";

export interface SignInState {
  error: string | null;
}

export async function signInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? "")) ?? "/console";

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const result = await signIn(await store(), { email, password });
  if (!result.ok) return { error: result.error };

  await setSessionCookie(result.token);
  // Outside the try/catch shape above on purpose: `redirect` works by throwing, and a
  // `catch` around it would swallow the navigation and leave the user on the form having
  // successfully signed in.
  redirect(next);
}
