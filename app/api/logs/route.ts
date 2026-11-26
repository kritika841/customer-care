import { withRequestDatabase } from "../../../lib/database";
import { errorResponse, errorResponse as requestErrorResponse, HttpError } from "../../../lib/http";
import { ensureSchema, getRuntimeEnv } from "../../../lib/database";
import { access, manager } from "../../../lib/operations/access";

export const dynamic = "force-dynamic";

async function handleGET(request: Request) {
  const u = await access(request, "support");
  if (!manager(u)) {
    throw new HttpError(403, "Manager access required");
  }
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  const rows = await runtime.DB.prepare(`
    SELECT id, source, event_type AS eventType, level, message,
      details_json AS detailsJson, created_at AS createdAt
    FROM activity_logs
    ORDER BY created_at DESC, id DESC
    LIMIT 200
  `).all<Record<string, unknown>>();
  const stateRows = await runtime.DB.prepare(`
    SELECT key, value FROM sync_state
    WHERE key IN ('sync_status', 'last_sync_at', 'last_sync_mode', 'last_sync_count', 'last_sync_error', 'fast_sync_checked_at', 'fast_sync_error')
  `).all<{ key: string; value: string }>();
  return Response.json({
    logs: rows.results.map((row) => {
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(String(row.detailsJson || "{}"));
      } catch {
        details = {};
      }
      return { ...row, details, detailsJson: undefined };
    }),
    sync: Object.fromEntries(stateRows.results.map((row) => [row.key, row.value])),
  });
}

async function GETHandler(...args: Parameters<typeof handleGET>) {
  try {
    return await handleGET(...args);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(...args: Parameters<typeof GETHandler>) {
  try {
    return await withRequestDatabase(() => GETHandler(...args), 20000);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
