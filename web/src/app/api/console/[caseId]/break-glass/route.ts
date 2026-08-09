/**
 * Break glass on a case: close it below the gate's floor.
 *
 * Separate from `/override` rather than a flag on it, matching `lib/breakglass.ts`. The
 * two are different claims — one is about urgency, one is about the gate being wrong —
 * and a single endpoint with a `force: true` field would make the dangerous one reachable
 * by a client that set the wrong boolean.
 *
 * Every counsellor can call this. Role only gates *review*; see the module doc for why
 * blocking the urgent path on finding a second person is a control that backfires.
 */

import { BreakGlassError, breakGlass } from "@/lib/breakglass";
import { requireCounsellorApi } from "@/lib/auth/current";
import { cardById } from "@/lib/cards";
import { store } from "@/lib/store";
import { TIER_ORDER, Tier } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  const auth = await requireCounsellorApi();
  if (!auth.ok) return auth.response;

  const { caseId } = await context.params;
  const card = cardById(caseId);
  if (!card) return Response.json({ error: "no such case" }, { status: 404 });

  let body: { closedAtTier?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }

  const closedAtTier = body.closedAtTier;
  if (typeof closedAtTier !== "string" || !TIER_ORDER.includes(closedAtTier as Tier)) {
    return Response.json(
      { error: `closedAtTier must be one of ${TIER_ORDER.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const record = await breakGlass(await store(), {
      caseId,
      principal: auth.principal,
      // From the card, never from the request body. A floor the client could name is a
      // floor the client could lower, which would make the whole ceremony decorative.
      gateFloor: card.gateFloor,
      closedAtTier: closedAtTier as Tier,
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    return Response.json({ breakGlass: record });
  } catch (e) {
    if (e instanceof BreakGlassError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
