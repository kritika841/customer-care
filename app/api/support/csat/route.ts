import { clientIpFromRequest, consumeRateLimit } from "../../../../lib/auth/rate-limit";
import { withRequestDatabase } from "../../../../lib/database";
import { errorResponse, errorResponse as requestErrorResponse } from "../../../../lib/http";
import { getCsatContext, submitCsatRating } from "../../../../lib/operations/support";

export const dynamic = "force-dynamic";

async function GETHandler(r: Request) {
  try {
    const ip = clientIpFromRequest(r);
    const rl = await consumeRateLimit(`csat_get:${ip}`, 30, 300);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }
    const token = new URL(r.url).searchParams.get("token") || "";
    const ticket = await getCsatContext(token);
    if (!ticket) {
      return Response.json({ error: "Feedback link not found or expired" }, { status: 404 });
    }
    return Response.json({ ticket });
  } catch (e) {
    return errorResponse(e);
  }
}

async function POSTHandler(r: Request) {
  try {
    const b = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return Response.json({ error: "Invalid submission" }, { status: 400 });
    const token = String(b.token || "").trim();
    const ip = clientIpFromRequest(r);
    const rl = await consumeRateLimit(`csat_post:${ip}:${token.slice(0, 12)}`, 10, 900);
    if (!rl.allowed) {
      return Response.json(
        { error: "Too many rating attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }
    const updated = await submitCsatRating(
      token,
      Number(b.score || 0),
      String(b.comment || ""),
    );
    return Response.json({ ok: true, ticket: updated });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(...args: Parameters<typeof GETHandler>) {
  try {
    return await withRequestDatabase(() => GETHandler(...args), 15000);
  } catch (error) {
    return requestErrorResponse(error);
  }
}

export async function POST(...args: Parameters<typeof POSTHandler>) {
  try {
    return await withRequestDatabase(() => POSTHandler(...args), 15000);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
