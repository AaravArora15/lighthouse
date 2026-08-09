/**
 * Sign out: revoke the session server-side, then clear the cookie.
 *
 * POST only. A GET would let any page a counsellor visits sign them out with an
 * `<img src="/sign-out">`, which is a nuisance rather than a breach, but the fix is one
 * line and a safeguarding tool that logs people out at random loses their trust quickly.
 */

import { redirect } from "next/navigation";

import { clearSession } from "@/lib/auth/current";

export const runtime = "nodejs";

export async function POST() {
  await clearSession();
  redirect("/sign-in");
}
