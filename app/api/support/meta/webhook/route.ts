import { timingSafeEqual } from "node:crypto";
import { withRequestDatabase } from "../../../../../lib/database";
import { errorResponse, HttpError } from "../../../../../lib/http";
import { ingestMetaWebhook, verifyMetaSignature } from "../../../../../lib/operations/meta";
import { autoDraftPendingInboundTickets } from "../../../../../lib/operations/ai-agent";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = (process.env.META_WEBHOOK_VERIFY_TOKEN || "").trim();
  if (!expected) {
    return new Response("Meta webhook verify token is not configured", { status: 503 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";

  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && timingSafeEqual(a, b);

  if (mode === "subscribe" && matches) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  return withRequestDatabase(async () => {
    try {
      if (!process.env.META_APP_SECRET) {
        throw new HttpError(503, "META_APP_SECRET is not configured");
      }
      const rawBody = await request.text();
      const signature = request.headers.get("x-hub-signature-256");
      if (!verifyMetaSignature(rawBody, signature)) {
        throw new HttpError(401, "Invalid Meta webhook signature");
      }
      const payload = JSON.parse(rawBody || "{}");
      const result = await ingestMetaWebhook(payload);
      if (result.ticketIds?.length) {
        await autoDraftPendingInboundTickets(10, result.ticketIds).catch((err) => {
          console.warn("Meta webhook auto-draft failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
      }
      return Response.json({ ok: true, ...result });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
