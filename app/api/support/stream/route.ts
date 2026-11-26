import { withRequestDatabase } from "../../../../lib/database";
import { errorResponse } from "../../../../lib/http";
import { access, manager } from "../../../../lib/operations/access";
import { operationsDb } from "../../../../lib/operations/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function activeViewers(raw: unknown, excludeUserId: string) {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, { name?: string; at?: string }>)
      : {};
  const cutoff = Date.now() - 45_000;
  return Object.entries(obj)
    .filter(([uid, info]) => {
      if (!uid || uid === excludeUserId) return false;
      const ts = new Date(String(info?.at || "")).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .map(([userId, info]) => ({
      userId,
      name: String(info?.name || "Teammate"),
      at: String(info?.at || ""),
    }));
}

async function GETHandler(r: Request) {
  try {
    const u = await access(r, "support");
    const canManage = manager(u);
    const ticketId = new URL(r.url).searchParams.get("ticket") || "";
    const db = await operationsDb();

    const encoder = new TextEncoder();
    let closed = false;
    let lastPayloadJson = "";

    const stream = new ReadableStream({
      async start(controller) {
        const pushSnapshot = async (force = false) => {
          if (closed) return;
          const summary = canManage
            ? await db
                .prepare(
                  "SELECT COUNT(*)::int AS count, COALESCE(MAX(updated_at)::text, '') AS max_updated FROM support_tickets",
                )
                .first<{ count: number; max_updated: string }>()
            : await db
                .prepare(
                  "SELECT COUNT(*)::int AS count, COALESCE(MAX(updated_at)::text, '') AS max_updated FROM support_tickets WHERE assignee_id = ?",
                )
                .bind(u.id)
                .first<{ count: number; max_updated: string }>();

          let selectedVersion: number | null = null;
          let viewers: Array<{ userId: string; name: string; at: string }> = [];
          if (ticketId) {
            const ticketRow = await db
              .prepare(
                `SELECT version, viewing_by FROM support_tickets WHERE id = ?${canManage ? "" : " AND assignee_id = ?"}`,
              )
              .bind(...(canManage ? [ticketId] : [ticketId, u.id]))
              .first<{ version: number; viewing_by: unknown }>()
              .catch(() => null);
            if (ticketRow) {
              selectedVersion = Number(ticketRow.version);
              viewers = activeViewers(ticketRow.viewing_by, u.id);
            }
          }

          if (closed) return;
          const payloadJson = JSON.stringify({
            count: Number(summary?.count || 0),
            maxUpdated: String(summary?.max_updated || ""),
            selectedVersion,
            activeViewers: viewers,
          });
          if (force || payloadJson !== lastPayloadJson) {
            lastPayloadJson = payloadJson;
            controller.enqueue(encoder.encode(`event: sync\ndata: ${payloadJson}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          }
        };

        r.signal.addEventListener("abort", () => {
          closed = true;
          try {
            controller.close();
          } catch {
            /* stream already closed */
          }
        });

        try {
          await pushSnapshot(true);
          for (let i = 0; i < 10 && !closed; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (closed) break;
            await pushSnapshot(false);
          }
        } catch {
          /* terminate stream cleanly on DB timeout/disconnect */
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(...args: Parameters<typeof GETHandler>) {
  try {
    return await withRequestDatabase(() => GETHandler(...args), 60000);
  } catch (error) {
    return errorResponse(error);
  }
}
