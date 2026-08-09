/**
 * Who is signed in, and the way out.
 *
 * Present on every console screen for a reason beyond navigation: a counsellor should
 * never be unsure whose name the next action will be logged under. Shared devices are
 * normal in a school office, and "I thought I was signed in as me" is the excuse an audit
 * log has to make impossible rather than merely implausible.
 */

import Link from "next/link";

import type { Principal } from "@/lib/auth/session";

export function ConsoleHeader({ principal }: { principal: Principal }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-3 text-xs dark:border-stone-800">
      <p className="text-stone-600 dark:text-stone-400">
        Signed in as <strong className="font-medium">{principal.displayName}</strong>{" "}
        <span className="text-stone-500 dark:text-stone-500">({principal.email})</span>
        {principal.role === "lead" && (
          <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 font-medium text-stone-700 dark:bg-stone-800 dark:text-stone-300">
            safeguarding lead
          </span>
        )}
      </p>

      <div className="flex items-center gap-3">
        <Link href="/console" className="underline underline-offset-4">
          Queue
        </Link>
        {/* A form, because sign-out is a POST. See app/sign-out/route.ts. */}
        <form action="/sign-out" method="post">
          <button type="submit" className="underline underline-offset-4">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
