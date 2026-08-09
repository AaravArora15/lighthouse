/**
 * The retention job, as an endpoint a scheduler calls.
 *
 * A cron-triggered route rather than a script, because this deploys to serverless and
 * there is no box to put a crontab on. Vercel Cron sends a GET with an `Authorization:
 * Bearer $CRON_SECRET` header; the same secret works from `curl` for a manual run.
 *
 * ## GET is a dry run. Deleting takes a POST.
 *
 * Scheduling a GET that erases children's disclosures is one misconfigured cron expression
 * away from an incident, and a GET is the verb every uptime monitor, link prefetcher and
 * crawler reaches for by default. So GET reports what *would* go and POST is the one that
 * acts. The scheduled job posts; anyone checking on it gets the harmless verb.
 *
 * ## No secret means no run
 *
 * If `CRON_SECRET` is unset the route refuses both verbs rather than running unauthenticated.
 * An open endpoint that deletes data is worse than a retention job that has not been
 * configured yet, and the second failure is visible in a way the first is not.
 */

import { describeSweep, sweep } from "@/lib/retention";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function refuse(): Response {
  const configured = Boolean(process.env.CRON_SECRET);
  return Response.json(
    {
      error: configured
        ? "Unauthorised."
        : "CRON_SECRET is not set, so the retention job is disabled. Set it in the " +
          "environment before scheduling this route.",
    },
    { status: configured ? 401 : 503 },
  );
}

export async function GET(request: Request) {
  if (!authorised(request)) return refuse();
  const result = await sweep(await store(), { dryRun: true });
  console.info("[retention] dry run\n" + describeSweep(result));
  return Response.json({ dryRun: true, ...result });
}

export async function POST(request: Request) {
  if (!authorised(request)) return refuse();
  const result = await sweep(await store(), { dryRun: false });
  console.info("[retention] applied\n" + describeSweep(result));
  return Response.json({ dryRun: false, ...result });
}
