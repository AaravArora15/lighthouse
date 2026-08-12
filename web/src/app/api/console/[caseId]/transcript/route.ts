/**
 * Open a case's full redacted transcript.
 *
 * POST rather than GET, and deliberately so. This is not a read: it writes an audit row
 * the student is entitled to see, and a GET that mutates the record would be prefetched by
 * a browser, retried by a proxy, and replayed from history. `viewed_transcript` has to mean
 * a person decided to look.
 *
 * The reason threshold is enforced here as well as in the UI, in `openTranscript`, and
 * again in `recordAccess`. Three layers for one rule because the innermost is the one that
 * cannot be skipped by a client talking to the API directly.
 */

import { requireCounsellorApi } from "@/lib/auth/current";
import { AuditError } from "@/lib/audit";
import { caseById } from "@/lib/queue";
import { store } from "@/lib/store";
import { TranscriptError, openTranscript } from "@/lib/transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  const auth = await requireCounsellorApi();
  if (!auth.ok) return auth.response;

  const { caseId } = await context.params;

  const card = await caseById(caseId);
  if (!card) {
    return Response.json({ error: "no such case" }, { status: 404 });
  }

  let body: { reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }

  try {
    const turns = await openTranscript(await store(), {
      caseId,
      principal: auth.principal,
      tier: card.tier,
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    return Response.json({ turns });
  } catch (e) {
    if (e instanceof TranscriptError || e instanceof AuditError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
