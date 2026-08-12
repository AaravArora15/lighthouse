/**
 * Who is signed in, and the way out.
 *
 * Present on every console screen for a reason beyond navigation: a counsellor should
 * never be unsure whose name the next action will be logged under. Shared devices are
 * normal in a school office, and "I thought I was signed in as me" is the excuse an audit
 * log has to make impossible rather than merely implausible.
 *
 * So the identity is the largest thing in the bar, and the lead badge is a filled chip
 * rather than a grey one: the difference between a counsellor and a safeguarding lead is
 * the difference between being able to sign off a colleague's break-glass and not.
 */

import Link from "next/link";

import { LighthouseMark } from "@/components/mark";
import type { Principal } from "@/lib/auth/session";

export function ConsoleHeader({ principal }: { principal: Principal }) {
  return (
    <div className="mb-7 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line pb-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <LighthouseMark className="size-7" />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-medium">
            {principal.displayName}
            {principal.role === "lead" && (
              <span className="ml-2 rounded-md bg-accent-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-accent-text">
                safeguarding lead
              </span>
            )}
          </p>
          <p className="truncate text-xs text-faint">
            Signed in as {principal.email}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs font-medium">
        <Link
          href="/console"
          className="text-muted transition-colors hover:text-ink"
        >
          Queue
        </Link>
        {/* A form, because sign-out is a POST. See app/sign-out/route.ts. */}
        <form action="/sign-out" method="post">
          <button
            type="submit"
            className="text-muted transition-colors hover:text-ink"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
