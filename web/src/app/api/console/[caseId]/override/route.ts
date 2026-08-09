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
 * case does it through the day 8 break-glass path, which is logged differently and is
 * deliberately harder.
 *
 * Day 8 replaces the in-memory store with the `tier_overrides` and `counsellor_access`
 * tables and puts a real counsellor identity behind this. There is no auth yet, so the
 * actor is hardcoded — flagged here rather than left to be discovered.
 */

import { cardById } from "@/lib/cards";
import { recordOverride } from "@/lib/overrides";
import { TIER_ORDER, Tier } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Net-new on day 8. Until then every action is attributed to one demo actor. */
const DEMO_COUNSELLOR = "demo-counsellor";

const MIN_REASON_CHARS = 10;

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
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

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < MIN_REASON_CHARS) {
    // Enforced server-side as well as in the UI. The reason is the entire value of an
    // override; a client that skips it must not be able to write a useless row.
    return Response.json(
      { error: `a reason of at least ${MIN_REASON_CHARS} characters is required` },
      { status: 400 },
    );
  }

  // Read the floor directly. Do NOT infer it from `tierFloorReason`: that field is set
  // only when the gate CHANGED the tier, so on a case the model already scored T4 it is
  // null while the floor is very much T4. Day 6 shipped exactly that bug and a counsellor
  // could downgrade a self-harm disclosure to T1.
  const gateFloor = card.gateFloor;

  const override = recordOverride({
    caseId,
    counsellorId: DEMO_COUNSELLOR,
    predictedTier: card.tier,
    requestedTier: requestedTier as Tier,
    reason,
    gateFloor,
  });

  return Response.json({ override });
}
