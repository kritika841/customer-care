import { withRequestDatabase } from "../../../../lib/database";
import { errorResponse as requestErrorResponse } from "../../../../lib/http";
import { timingSafeEqual } from "node:crypto";
import { runSupport } from "../../../../lib/operations/gmail";
import { syncMetaInboxes, flushMetaOutbox } from "../../../../lib/operations/meta";
import { autoLinkTicketsToOrders, syncRecentShopifyFulfillmentsToOrders } from "../../../../lib/operations/rag";
import { autoDraftPendingInboundTickets } from "../../../../lib/operations/ai-agent";
import { errorResponse } from "../../../../lib/http";
export const maxDuration = 300;
async function GETHandler(r: Request) {
  const actual = Buffer.from(r.headers.get("authorization") || ""),
    expected = Buffer.from("Bearer " + (process.env.CRON_SECRET || ""));
  if (
    !process.env.CRON_SECRET ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const gmail = await runSupport().catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : "Gmail sync skipped",
    }));
    const meta = await syncMetaInboxes(30).catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : "Meta sync skipped",
    }));
    await flushMetaOutbox().catch(() => null);
    const shopify = await syncRecentShopifyFulfillmentsToOrders(150).catch(() => null);
    const linked = await autoLinkTicketsToOrders(80).catch(() => null);
    const ai = await autoDraftPendingInboundTickets(15).catch(() => null);
    return Response.json({ ok: true, gmail, meta, shopify, linked, ai });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(...args: Parameters<typeof GETHandler>) {
  try { return await withRequestDatabase(() => GETHandler(...args), 270000); }
  catch (error) { return requestErrorResponse(error); }
}
