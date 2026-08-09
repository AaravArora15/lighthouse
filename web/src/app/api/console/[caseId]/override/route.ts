/**
 * Record a counsellor's tier override.
 *
 * The one thing this route must get right: **it re-applies the gate floor to the
 * counsellor's choice.** `recordOverride` runs `applyFloor` over the requested tier, so a
 * request to move a T4 self-harm disclosure down to T1 is accepted, logged with its
 * reason, and results in T4.
 *
 * That is not the API being unhelpful. "No model output may lower a gate floor" is the
 * invariant this project rests on, and a counsellor clicking a button is an input to the
 * system like any other. The moment of human judgement is exactly the moment things get
 * missed, which is why the floor exists. A counsellor who genuinely needs to close such a
 * case does it through `/break-glass`, which is logged differently and is deliberately
 * harder.
 */

import { requireCounsellorApi } from "@/lib/auth/current";
import { cardById } from "@/lib/cards";
import { OverrideError, recordOverride } from "@/lib/overrides";
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
  if (!card) {
    return Response.json({ error: "no such case" }, { status: 404 });
  }

  let body: { requestedTier?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }

  const requestedTier = body.requestedTier;
  if (typeof requestedTier !== "string" || !TIER_ORDER.includes(requestedTier as Tier)) {
    return Response.json(
      { error: `requestedTier must be one of ${TIER_ORDER.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    // Read the floor directly. Do NOT infer it from `tierFloorReason`: that field is set
    // only when the gate CHANGED the tier, so on a case the model already scored T4 it is
    // null while the floor is very much T4. Day 6 shipped exactly that bug and a
    // counsellor could downgrade a self-harm disclosure to T1.
    const override = await recordOverride(await store(), {
      caseId,
      principal: auth.principal,
      predictedTier: card.tier,
      requestedTier: requestedTier as Tier,
      reason: typeof body.reason === "string" ? body.reason : "",
      gateFloor: card.gateFloor,
    });
    return Response.json({ override });
  } catch (e) {
    // The reason threshold is enforced server-side as well as in the UI. The reason is the
    // entire value of an override; a client that skips it must not write a useless row.
    if (e instanceof OverrideError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
