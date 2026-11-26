import { operationsDb } from "./schema";

export type AiLiveGateResult = {
  allowed: boolean;
  reason: string;
  operatingMode: string;
};

/**
 * Single authoritative gate for whether an `ai_agent`-created outbound message
 * is allowed to actually leave the outbox to a real customer.
 */
export async function checkAiLiveOutboundGate(params: {
  channel: string;
  customerEmail?: string | null;
  externalUsername?: string | null;
  externalUserId?: string | null;
}): Promise<AiLiveGateResult> {
  if (process.env.AI_LIVE_OUTBOUND_ENABLED !== "true") {
    return {
      allowed: false,
      reason: "Blocked by AI_LIVE_OUTBOUND_ENABLED environment safety gate",
      operatingMode: "draft_only",
    };
  }

  const db = await operationsDb();
  const row = await db
    .prepare(
      "SELECT operating_mode, live_outbound_enabled, approval_mode_enabled, test_recipient_allowlist FROM support_ai_settings WHERE id = 'default'",
    )
    .first<{
      operating_mode?: string;
      live_outbound_enabled?: boolean;
      approval_mode_enabled?: boolean;
      test_recipient_allowlist?: unknown;
    }>()
    .catch(() => null);

  if (row?.approval_mode_enabled !== false) {
    return {
      allowed: false,
      reason: "Approval Mode is ON — AI reply staged for human Approve/Decline",
      operatingMode: "draft_only",
    };
  }

  const mode = String(row?.operating_mode || "draft_only");
  const dbEnabled = Boolean(row?.live_outbound_enabled === true);

  if (!dbEnabled || mode === "off" || mode === "draft_only") {
    return {
      allowed: false,
      reason: "Blocked by dashboard AI Safe Mode settings",
      operatingMode: mode,
    };
  }

  if (mode === "live_auto") {
    return { allowed: true, reason: "live_auto enabled", operatingMode: mode };
  }

  if (mode === "allowlist_only") {
    const rawList = Array.isArray(row?.test_recipient_allowlist)
      ? row.test_recipient_allowlist
      : typeof row?.test_recipient_allowlist === "string"
        ? (() => {
            try {
              const p = JSON.parse(row.test_recipient_allowlist);
              return Array.isArray(p) ? p : [];
            } catch {
              return [];
            }
          })()
        : [];
    const allowSet = new Set(
      rawList
        .map((x) => String(x || "").trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    );
    const candidates = [
      params.customerEmail,
      params.externalUsername,
      params.externalUserId,
    ]
      .map((v) => String(v || "").trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);

    const matched = candidates.some((c) => allowSet.has(c));
    if (matched) {
      return { allowed: true, reason: "Matched recipient allowlist", operatingMode: mode };
    }
    return {
      allowed: false,
      reason: "Recipient is not in the allowlist_only test list",
      operatingMode: mode,
    };
  }

  return {
    allowed: false,
    reason: "Unsupported AI operating mode",
    operatingMode: mode,
  };
}
