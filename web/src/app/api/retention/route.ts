/**
 * The retention job, as an endpoint a scheduler calls.
 *
 * A cron-triggered route rather than a script, because this deploys to serverless and
 * there is no box to put a crontab on. Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`; the same secret works from `curl` for a manual run.
 *
 * ## Applying is opt-in, and the default is a dry run
 *
 *     GET  /api/retention              -> report what would go, change nothing
 *     GET  /api/retention?apply=1      -> delete   (this is what the cron calls)
 *     POST /api/retention              -> delete   (for a human with curl)
 *
 * The first draft made POST the only deleting verb, on the reasoning that a GET is what
 * every uptime monitor and prefetcher reaches for. That was wrong here in a way worth
 * recording: **Vercel Cron can only issue GET**, so the scheduled job would have run a dry
 * run every night forever. It would have looked configured, logged plausible output, and
 * deleted nothing — and a retention promise that silently does not run is worse than one
 * that visibly failed, because nobody goes looking.
 *
 * So the verb is not the safety mechanism; the explicit `apply` is, and `CRON_SECRET` is
 * the access control. A bare GET from anything that stumbles onto the URL still changes
 * nothing, which was the point of the original design.
 *
 * ## No secret means no run
 *
 * With `CRON_SECRET` unset the route refuses everything rather than running
 * unauthenticated. An open endpoint that deletes children's disclosures is worse than a
 * retention job that has not been configured yet, and the second failure is visible in a
 * way the first is not.
 */

import { describeSweep, sweep } from "@/lib/retention";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
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

async function run(dryRun: boolean, asOf?: Date): Promise<Response> {
  const result = await sweep(await store(), { dryRun, now: asOf });
  console.info(`[retention] ${dryRun ? "dry run" : "applied"}\n` + describeSweep(result));
  return Response.json({ dryRun, asOf: asOf?.toISOString() ?? null, ...result });
}

export async function GET(request: Request) {
  if (!authorised(request)) return refuse();

  const params = new URL(request.url).searchParams;
  const apply = params.get("apply") === "1";

  /**
   * `?asOf=2026-12-01` answers "what would this delete then".
   *
   * Dry runs only, and refused outright alongside `apply`. The demo corpus is a few weeks
   * old, so a sweep today correctly reports that nothing is due — which demonstrates the
   * exemptions but not the deletion, and "nothing happened" is a poor way to show a
   * retention policy working. Time-travelling a *report* is honest; time-travelling the
   * deletion would be a way to erase records months early by adding a query parameter.
   */
  const raw = params.get("asOf");
  const asOf = raw ? new Date(raw) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) {
    return Response.json({ error: "asOf must be an ISO date" }, { status: 400 });
  }
  if (asOf && apply) {
    return Response.json(
      {
        error:
          "asOf is for dry runs only. Deleting against a clock the caller chose is not " +
          "a retention policy, it is an erase button with extra steps.",
      },
      { status: 400 },
    );
  }

  return run(!apply, asOf);
}

export async function POST(request: Request) {
  if (!authorised(request)) return refuse();
  return run(false);
}
