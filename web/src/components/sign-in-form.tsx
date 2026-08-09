"use client";

import { useActionState } from "react";

import { signInAction, type SignInState } from "@/app/sign-in/actions";

const INITIAL: SignInState = { error: null };

export function SignInForm({ next }: { next: string | null }) {
  const [state, action, pending] = useActionState(signInAction, INITIAL);

  return (
    <form action={action} className="mt-6 space-y-4">
      {next && <input type="hidden" name="next" value={next} />}

      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          School email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 dark:border-stone-700 dark:bg-stone-900"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 dark:border-stone-700 dark:bg-stone-900"
        />
      </div>

      {/* aria-live, so a screen reader announces the failure rather than leaving the user
          wondering whether the button did anything. */}
      <p aria-live="polite" className="min-h-5 text-sm text-red-700 dark:text-red-400">
        {state.error}
      </p>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
