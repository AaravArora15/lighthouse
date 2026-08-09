/**
 * Counsellor sign-in.
 *
 * Note what this page does not have: a sign-up link, a "forgot password" flow, and any
 * mention of the student-facing chat. Accounts are created by a safeguarding lead running
 * `npm run counsellor:add`, because the set of adults who may read children's disclosures
 * is a decision a school makes in a room, not one a web form makes. A self-service reset
 * would be an email-based path into that same set, which is worth building properly later
 * and is worth not faking now.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { SignInForm } from "@/components/sign-in-form";
import { currentCounsellor, safeNext } from "@/lib/auth/current";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  // Already signed in: go straight through rather than showing a form that will confuse
  // someone who followed a stale link.
  if (await currentCounsellor()) redirect(target ?? "/console");

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Lighthouse console</h1>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
        For school counselling staff. Everything you open here is logged against your name
        and the student can read that log.
      </p>

      <SignInForm next={target} />

      <p className="mt-8 text-xs text-stone-500 dark:text-stone-400">
        Accounts are created by your safeguarding lead. If you cannot get in, ask them
        rather than trying again.{" "}
        <Link href="/" className="underline underline-offset-4">
          Back to the student chat
        </Link>
        .
      </p>
    </main>
  );
}
