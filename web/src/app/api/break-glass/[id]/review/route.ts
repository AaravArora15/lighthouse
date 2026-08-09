/**
 * A safeguarding lead signs off a break-glass closure.
 *
 * The whole control on break-glass is that these rows exist, are counted, and get read by
 * a second person. Without this endpoint the console shows a number that never goes down,
 * which within a fortnight is a banner everybody scrolls past — and then the control is
 * gone while still appearing to be there.
 *
 * Routed off the record id rather than the case id: a case can be broken more than once
 * and a review names exactly one of them.
 */

import { BreakGlassError, reviewBreakGlass } from "@/lib/breakglass";
import { requireCounsellorApi } from "@/lib/auth/current";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireCounsellorApi();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;

  let body: { note?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "malformed body" }, { status: 400 });
  }

  try {
    const record = await reviewBreakGlass(await store(), {
      id,
      principal: auth.principal,
      note: typeof body.note === "string" ? body.note : "",
    });
    return Response.json({ breakGlass: record });
  } catch (e) {
    if (e instanceof BreakGlassError) {
      // 403 where the refusal is about who is asking, 400 where it is about what they sent.
      // A lead hitting "you cannot review your own" should not read it as a bad request.
      const forbidden =
        e.message.includes("safeguarding lead can review") ||
        e.message.includes("your own break-glass");
      return Response.json({ error: e.message }, { status: forbidden ? 403 : 400 });
    }
    throw e;
  }
}
