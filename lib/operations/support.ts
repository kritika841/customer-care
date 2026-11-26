import { randomUUID } from "node:crypto";
import type { DashboardUser } from "../auth/access";
import type { TransactionSql } from "postgres";
import { getSupabaseAdmin } from "../supabase/admin";
import { HttpError, required } from "../http";
import { operationsDb } from "./schema";
import { manager } from "./access";
import {
  computeCustomer360,
  computeSlaDueAt,
  extractOrderOrPhoneHints,
  type Customer360Summary,
} from "./sla";
import { estimateTokenCount } from "./ai-provider";
import { getAiSettings, type AiSettings } from "./ai-agent";
import { buildCourierTrackingUrl } from "./rag";

// Support records combine ticket, mailbox and user tables. Mutation inputs are
// validated below; the workspace reads the selected row's dynamic columns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupportRow = { [key: string]: any };

export type SupportSnapshot = {
  tickets: SupportRow[];
  selectedTicket: SupportRow | null;
  page: number;
  totalPages: number;
  total: number;
  summary: SupportRow;
  agents: SupportRow[];
  availableAgents: number;
  messages: SupportRow[];
  events: SupportRow[];
  orders: SupportRow[];
  customer: {
    name: string;
    email: string;
    phone: string;
    city?: string;
    state?: string;
    tags: string[];
  };
  customer360: Customer360Summary;
  linkedCustomer: {
    isLinked: boolean;
    linkedOrderId: number | null;
    linkedEmail: string;
    linkedPhone: string;
    linkedName: string;
  };
  activeViewers: Array<{ userId: string; name: string; at: string }>;
  templates: SupportRow[];
  connection: SupportRow;
  socialConnections: SupportRow[];
  canManage: boolean;
  userId: string;
  configured: boolean;
  pushConfigured: boolean;
  metaSystemConfigured: boolean;
  metaPageId: string;
  aiSettings?: AiSettings;
  aiEscalations?: SupportRow[];
  aiThreadTokenEstimate?: number;
  aiChatTokenTotals?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    requestCount: number;
  };
  aiChatTokenLogs?: Array<{
    id: string;
    messageId: string | null;
    operationType: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    createdAt: string;
  }>;
  aiKnowledgeSummary?: {
    totalDocuments: number;
    totalChunks: number;
    policyCount: number;
    productCount: number;
    faqCount: number;
    adminMemoryCount: number;
    templateCount: number;
  };
};

export const mailbox = () => process.env.SUPPORT_MAILBOX || "kritika@satmi.in";

function customerTags(raw: unknown) {
  try {
    const value = JSON.parse(String(raw || "{}"));
    const tags = value.shopify_tags ?? value.tags ?? value.order_tag ?? [];
    return (Array.isArray(tags) ? tags : String(tags).split(","))
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function normalizePreferredChannels(raw: unknown): string[] {
  const allowed = new Set(["email", "instagram", "facebook"]);
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = raw.split(",");
    }
  }
  const normalized = [
    ...new Set(list.map((c) => String(c).trim().toLowerCase()).filter((c) => allowed.has(c))),
  ];
  return normalized.length ? normalized : ["email", "instagram", "facebook"];
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

function activeViewersFromJson(raw: unknown, excludeUserId: string) {
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

export async function supportEvent(
  sql: TransactionSql,
  u: string,
  id: string,
  action: string,
  details: unknown = {},
) {
  await sql`INSERT INTO support_events(ticket_id,actor_id,action,details) VALUES(${id},${u},${action},${JSON.stringify(details)})`;
}

export async function assignWaitingTickets(sql: TransactionSql) {
  const [hasWaiting] = await sql`
    SELECT 1 AS found
    FROM support_tickets
    WHERE assignee_id IS NULL AND status IN ('open', 'in_progress', 'waiting')
    LIMIT 1
  `;
  if (!hasWaiting) return;

  await sql`SELECT pg_advisory_xact_lock(421995)`;
  const agentRows = await sql`
    SELECT a.user_id,
           COALESCE(a.max_open_tickets, 25)::int AS max_open_tickets,
           a.preferred_channels,
           COUNT(t.id)::int AS load
    FROM support_agents a
    LEFT JOIN support_tickets t
      ON t.assignee_id = a.user_id AND t.status <> 'resolved'
    WHERE a.available AND a.role = 'support_agent'
    GROUP BY a.user_id, a.max_open_tickets, a.preferred_channels
  `;
  if (!agentRows.length) return;

  const agents = agentRows.map((a) => ({
    user_id: String(a.user_id),
    max_open_tickets: Math.max(1, Number(a.max_open_tickets || 25)),
    preferred_channels: normalizePreferredChannels(a.preferred_channels),
    load: Number(a.load || 0),
  }));

  const waiting = await sql`
    SELECT id, COALESCE(channel, 'email') AS channel
    FROM support_tickets
    WHERE assignee_id IS NULL AND status IN ('open', 'in_progress', 'waiting')
    ORDER BY created_at, id
    FOR UPDATE
  `;

  for (const ticket of waiting) {
    const ticketChannel = String(ticket.channel || "email");
    const eligible = agents.filter((a) => a.load < a.max_open_tickets);
    if (!eligible.length) break;

    eligible.sort((a, b) => {
      const aAff = a.preferred_channels.includes(ticketChannel) ? 0 : 1;
      const bAff = b.preferred_channels.includes(ticketChannel) ? 0 : 1;
      if (aAff !== bAff) return aAff - bAff;
      if (a.load !== b.load) return a.load - b.load;
      return a.user_id.localeCompare(b.user_id);
    });

    const chosen = eligible[0];
    await sql`UPDATE support_tickets SET assignee_id=${chosen.user_id},updated_at=now() WHERE id=${ticket.id}`;
    await supportEvent(sql, "system", String(ticket.id), "auto_assigned", {
      agentId: chosen.user_id,
      channel: ticketChannel,
      load: chosen.load + 1,
      maxOpenTickets: chosen.max_open_tickets,
    });
    chosen.load += 1;
  }
}

export async function ticketAccess(
  sql: TransactionSql,
  id: string,
  u: DashboardUser,
  lock = true,
) {
  const [t] = lock
    ? await sql`SELECT * FROM support_tickets WHERE id=${id} FOR UPDATE`
    : await sql`SELECT * FROM support_tickets WHERE id=${id}`;
  if (!t) throw new HttpError(404, "Ticket not found");
  if (!manager(u) && t.assignee_id !== u.id)
    throw new HttpError(403, "This ticket is not assigned to you");
  return t;
}

type SyncedUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  banned_until: string | null;
};

export async function refreshAgents() {
  const db = await operationsDb();
  const userMap = new Map<string, SyncedUser>();

  const localUsers = await db
    .prepare("SELECT id, email, name, role, banned_until FROM auth_users")
    .all<SyncedUser>()
    .catch(() => ({ results: [] as SyncedUser[] }));

  for (const u of localUsers.results) {
    const email = (u.email || "").trim().toLowerCase();
    if (!email) continue;
    userMap.set(email, u);
  }

  const pgAuthUsers = await db
    .prepare(
      `SELECT id::text AS id, email,
              COALESCE(raw_user_meta_data->>'name', email) AS name,
              COALESCE(raw_app_meta_data->>'role', 'user') AS role,
              banned_until
       FROM auth.users`,
    )
    .all<SyncedUser>()
    .catch(() => ({ results: [] as SyncedUser[] }));

  for (const u of pgAuthUsers.results) {
    const email = (u.email || "").trim().toLowerCase();
    if (!email) continue;
    userMap.set(email, u);
  }

  if (
    userMap.size === 0 &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    try {
      for (let page = 1; ; page++) {
        const { data, error } = await getSupabaseAdmin().auth.admin.listUsers({
          page,
          perPage: 200,
        });
        if (error) break;
        for (const u of data.users) {
          const email = (u.email || "").trim().toLowerCase();
          if (!email) continue;
          userMap.set(email, {
            id: u.id,
            email: u.email || "",
            name: String(u.user_metadata?.name || u.email || ""),
            role: String(u.app_metadata?.role || "user"),
            banned_until: u.banned_until || null,
          });
        }
        if (data.users.length < 200) break;
      }
    } catch {
      /* ignore remote Supabase failure when using local Postgres */
    }
  }

  const users = Array.from(userMap.values()).map((u) => ({
    ...u,
    role: u.role === "customer_support" ? "support_agent" : u.role,
  }));

  await db.transaction(async (sql) => {
    if (users.length > 0) {
      await sql`UPDATE support_agents SET available=FALSE WHERE user_id NOT IN ${sql(
        users
          .filter(
            (u) =>
              ["admin", "support_agent", "support_manager"].includes(u.role) &&
              (!u.banned_until || new Date(u.banned_until) < new Date()),
          )
          .map((u) => u.id)
          .concat("__none__"),
      )}`;
      for (const u of users) {
        if (
          !["admin", "support_agent", "support_manager"].includes(u.role) ||
          (u.banned_until && new Date(u.banned_until) > new Date())
        )
          continue;
        await sql`INSERT INTO support_agents(user_id,email,name,role) VALUES(${u.id},${u.email || ""},${u.name || u.email || ""},${u.role}) ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,role=EXCLUDED.role`;
      }
    }
    await assignWaitingTickets(sql);
  });
}

export async function supportData(
  u: DashboardUser,
  id?: string,
  filters: {
    page?: number;
    queue?: string;
    search?: string;
    channel?: string;
    sort?: string;
  } = {},
): Promise<SupportSnapshot> {
  const db = await operationsDb();
  const canManage = manager(u);
  const page = Number.isFinite(filters.page)
    ? Math.max(1, Math.min(100000, Math.floor(filters.page || 1)))
    : 1;
  const allowedQueues = new Set([
    "all",
    "mine",
    "unassigned",
    "needs_reply",
    "ai_needs_admin",
    "ai_human_action",
    "ai_drafts",
    "human_queue",
    "pending_approval",
    "open",
    "in_progress",
    "waiting",
    "escalated",
    "resolved",
  ]);
  const queue = allowedQueues.has(filters.queue || "")
    ? String(filters.queue)
    : "all";
  const allowedChannels = new Set(["all", "email", "instagram", "facebook"]);
  const channelFilter = allowedChannels.has(filters.channel || "")
    ? String(filters.channel)
    : "all";
  const allowedSorts = new Set([
    "newest",
    "oldest",
    "updated",
    "needs_reply",
    "fifo",
    "sla",
    "ticket_desc",
    "ticket_asc",
  ]);
  const sort = allowedSorts.has(filters.sort || "")
    ? String(filters.sort)
    : "newest";

  const clauses: string[] = [];
  const values: unknown[] = [];
  if (!canManage) {
    clauses.push("support_tickets.assignee_id=?");
    values.push(u.id);
  }
  if (queue === "mine") {
    clauses.push("support_tickets.assignee_id=?");
    values.push(u.id);
  } else if (queue === "unassigned") {
    clauses.push("support_tickets.assignee_id IS NULL");
  } else if (queue === "needs_reply") {
    clauses.push(
      `support_tickets.status <> 'resolved' AND COALESCE((
         SELECT sm_dir.direction FROM support_messages sm_dir
         WHERE sm_dir.ticket_id = support_tickets.id
           AND sm_dir.delivery_status <> 'ai_draft'
         ORDER BY sm_dir.created_at DESC, sm_dir.id DESC LIMIT 1
       ), 'inbound') = 'inbound'`,
    );
  } else if (queue === "ai_needs_admin") {
    clauses.push(
      "support_tickets.status <> 'resolved' AND support_tickets.ai_status IN ('needs_admin_input', 'needs_human_action')",
    );
  } else if (queue === "ai_human_action") {
    clauses.push(
      "support_tickets.status <> 'resolved' AND support_tickets.ai_status = 'needs_human_action'",
    );
  } else if (queue === "ai_drafts") {
    clauses.push(
      "support_tickets.status <> 'resolved' AND support_tickets.ai_status = 'draft_ready'",
    );
  } else if (queue === "human_queue") {
    clauses.push(
      "support_tickets.status <> 'resolved' AND (support_tickets.ai_status IN ('needs_admin_input', 'needs_human_action') OR support_tickets.status = 'escalated')",
    );
  } else if (queue === "pending_approval") {
    clauses.push(
      "support_tickets.status <> 'resolved' AND support_tickets.ai_status IN ('draft_ready', 'needs_admin_input', 'needs_human_action')",
    );
  } else if (queue !== "all") {
    clauses.push("support_tickets.status=?");
    values.push(queue);
  }
  if (channelFilter !== "all") {
    clauses.push("COALESCE(support_tickets.channel, 'email')=?");
    values.push(channelFilter);
  }
  if (filters.search?.trim()) {
    clauses.push(
      "(support_tickets.subject ILIKE ? OR support_tickets.customer_email ILIKE ? OR support_tickets.customer_name ILIKE ? OR support_tickets.external_username ILIKE ? OR support_tickets.ticket_number::text ILIKE ?)",
    );
    const search = `%${filters.search.trim().slice(0, 200)}%`;
    values.push(search, search, search, search, search);
  }
  const where = clauses.join(" AND ") || "TRUE";
  const summaryWhere = canManage ? "TRUE" : "assignee_id=?";
  const summaryValues = canManage ? [] : [u.id];

  const latestActivityExpr = `COALESCE(latest_msg.msg_at, latest_inbound.customer_at, support_tickets.last_inbound_at, support_tickets.created_at)`;
  const orderByClause =
    sort === "fifo"
      ? `CASE WHEN support_tickets.status = 'resolved' THEN 1 ELSE 0 END ASC,
         CASE WHEN COALESCE(latest_msg.direction, 'inbound') = 'inbound' THEN 0 ELSE 1 END ASC,
         COALESCE(support_tickets.last_inbound_at, latest_inbound.customer_at, support_tickets.created_at) ASC,
         support_tickets.ticket_number ASC,
         support_tickets.id`
      : sort === "sla"
        ? `CASE WHEN support_tickets.status = 'resolved' THEN 2 WHEN COALESCE(latest_msg.direction, 'inbound') = 'inbound' OR support_tickets.first_response_at IS NULL THEN 0 ELSE 1 END ASC,
           COALESCE(support_tickets.sla_due_at, support_tickets.created_at + interval '12 hours') ASC,
           ${latestActivityExpr} DESC,
           support_tickets.id`
        : sort === "oldest"
          ? `${latestActivityExpr} ASC, support_tickets.ticket_number ASC, support_tickets.id`
          : sort === "updated"
            ? `support_tickets.updated_at DESC, support_tickets.ticket_number DESC, support_tickets.id`
            : sort === "needs_reply"
              ? `CASE WHEN support_tickets.status = 'resolved' THEN 2 WHEN COALESCE(latest_msg.direction, 'inbound') = 'inbound' THEN 0 ELSE 1 END ASC,
                 ${latestActivityExpr} DESC,
                 support_tickets.id`
              : sort === "ticket_desc"
                ? `support_tickets.ticket_number DESC, support_tickets.id`
                : sort === "ticket_asc"
                  ? `support_tickets.ticket_number ASC, support_tickets.id`
                  : `${latestActivityExpr} DESC, support_tickets.ticket_number DESC, support_tickets.id`;

  const [
    ticketRows,
    totalRow,
    summaryRow,
    agentRows,
    connection,
    socialRows,
    templateRows,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT support_tickets.*,
           COALESCE(ord.channel_order_id, '') AS order_code,
           COALESCE(ord.awb, '') AS order_tracking_id,
           COALESCE(ord.courier, '') AS order_courier,
           COALESCE(ord.status, '') AS order_status,
           COALESCE(NULLIF(support_tickets.associated_phone, ''), scl.customer_phone, ord.customer_phone, '') AS resolved_customer_phone,
           COALESCE(latest_msg.excerpt, '') AS excerpt,
           COALESCE(latest_msg.direction, '') AS last_direction,
           COALESCE(latest_msg.message_count, 0) AS message_count,
           COALESCE(latest_msg.msg_at, latest_inbound.customer_at, support_tickets.last_inbound_at, support_tickets.created_at) AS last_message_at,
           COALESCE(latest_inbound.customer_body, '') AS customer_last_body,
           latest_inbound.customer_at AS customer_last_at,
           COALESCE(latest_ai.ai_reply_id, '') AS ai_reply_id,
           COALESCE(latest_ai.ai_reply_body, '') AS ai_reply_body,
           latest_ai.ai_reply_at AS ai_reply_at,
           COALESCE(latest_ai.ai_delivery_status, '') AS ai_delivery_status,
           COALESCE(latest_ai.ai_reply_tokens, 0) AS ai_reply_tokens,
           COALESCE(latest_ai.ai_reply_cost_usd, 0) AS ai_reply_cost_usd,
           COALESCE(tok.ai_input_tokens, 0) AS ai_input_tokens,
           COALESCE(tok.ai_output_tokens, 0) AS ai_output_tokens,
           COALESCE(tok.ai_total_tokens, 0) AS ai_total_tokens,
           COALESCE(tok.ai_total_cost_usd, 0) AS ai_total_cost_usd,
           COALESCE(latest_esc.esc_id, '') AS ai_escalation_id,
           COALESCE(latest_esc.esc_type, '') AS ai_escalation_type,
           COALESCE(latest_esc.esc_category, '') AS ai_action_category,
           COALESCE(latest_esc.esc_question, '') AS ai_question_for_admin,
           latest_esc.esc_at AS ai_escalated_at
         FROM support_tickets
         LEFT JOIN orders ord ON ord.id = support_tickets.order_id
         LEFT JOIN support_customer_links scl
           ON scl.channel = COALESCE(support_tickets.channel, 'email')
          AND scl.external_user_id = COALESCE(NULLIF(support_tickets.external_user_id, ''), support_tickets.customer_email)
         LEFT JOIN LATERAL (
           SELECT
             LEFT(TRIM(REGEXP_REPLACE(sm.body, '<[^>]+>', ' ', 'g')), 650) AS excerpt,
             sm.direction,
             sm.created_at AS msg_at,
             (SELECT COUNT(*)::int FROM support_messages sm2 WHERE sm2.ticket_id = support_tickets.id AND sm2.delivery_status <> 'ai_draft') AS message_count
           FROM support_messages sm
           WHERE sm.ticket_id = support_tickets.id
             AND sm.delivery_status <> 'ai_draft'
           ORDER BY
             CASE
               WHEN sm.body ~* '^(Facebook created this chat because |Facebook ने यह चैट इसलिए बनाई है क्योंकि |Auto-label added:|Lead stage set to |You are responding to a user comment)'
                 OR sm.body ~* 'replied to a post\\.[[:space:]]*See post\\('
               THEN 1
               ELSE 0
             END ASC,
             sm.created_at DESC,
             sm.id DESC
           LIMIT 1
         ) latest_msg ON TRUE
         LEFT JOIN LATERAL (
           SELECT
             LEFT(TRIM(REGEXP_REPLACE(sm_in.body, '<[^>]+>', ' ', 'g')), 650) AS customer_body,
             sm_in.created_at AS customer_at
           FROM support_messages sm_in
           WHERE sm_in.ticket_id = support_tickets.id
             AND sm_in.direction = 'inbound'
           ORDER BY
             CASE
               WHEN sm_in.body ~* '^(Facebook created this chat because |Facebook ने यह चैट इसलिए बनाई है क्योंकि |Auto-label added:|Lead stage set to |You are responding to a user comment)'
                 OR sm_in.body ~* 'replied to a post\\.[[:space:]]*See post\\('
               THEN 1
               ELSE 0
             END ASC,
             sm_in.created_at DESC,
             sm_in.id DESC
           LIMIT 1
         ) latest_inbound ON TRUE
         LEFT JOIN LATERAL (
           SELECT
             sm_ai.id AS ai_reply_id,
             LEFT(TRIM(sm_ai.body), 900) AS ai_reply_body,
             sm_ai.created_at AS ai_reply_at,
             sm_ai.delivery_status AS ai_delivery_status,
             COALESCE((SELECT SUM(u2.total_tokens)::int FROM support_ai_token_usage u2 WHERE u2.message_id = sm_ai.id), 0) AS ai_reply_tokens,
             COALESCE((SELECT SUM(u2.estimated_cost_usd)::float8 FROM support_ai_token_usage u2 WHERE u2.message_id = sm_ai.id), 0) AS ai_reply_cost_usd
           FROM support_messages sm_ai
           WHERE sm_ai.ticket_id = support_tickets.id
             AND (sm_ai.delivery_status = 'ai_draft' OR sm_ai.created_by = 'ai_agent')
           ORDER BY sm_ai.created_at DESC, sm_ai.id DESC
           LIMIT 1
         ) latest_ai ON TRUE
         LEFT JOIN LATERAL (
           SELECT
             COALESCE(SUM(atu.input_tokens), 0)::int AS ai_input_tokens,
             COALESCE(SUM(atu.output_tokens), 0)::int AS ai_output_tokens,
             COALESCE(SUM(atu.total_tokens), 0)::int AS ai_total_tokens,
             COALESCE(SUM(atu.estimated_cost_usd), 0)::float8 AS ai_total_cost_usd
           FROM support_ai_token_usage atu
           WHERE atu.ticket_id = support_tickets.id
         ) tok ON TRUE
         LEFT JOIN LATERAL (
           SELECT
             esc.id AS esc_id,
             esc.escalation_type AS esc_type,
             esc.action_category AS esc_category,
             esc.ai_question_for_admin AS esc_question,
             esc.created_at AS esc_at
           FROM support_ai_escalations esc
           WHERE esc.ticket_id = support_tickets.id
             AND esc.status = 'pending'
           ORDER BY esc.created_at DESC
           LIMIT 1
         ) latest_esc ON TRUE
         WHERE ${where}
         ORDER BY ${orderByClause}
         LIMIT 50 OFFSET ?`,
      )
      .bind(...values, (page - 1) * 50)
      .all<Record<string, unknown>>(),
    db
      .prepare(`SELECT COUNT(*) count FROM support_tickets WHERE ${where}`)
      .bind(...values)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT
           COUNT(*) FILTER(WHERE status<>'resolved') open,
           COUNT(*) FILTER(WHERE status<>'resolved' AND assignee_id IS NULL) unassigned,
           COUNT(*) FILTER(WHERE status='escalated') escalated,
           COUNT(*) FILTER(WHERE status='resolved') resolved,
           COUNT(*) FILTER(WHERE status<>'resolved' AND COALESCE(channel,'email')='email') email_open,
           COUNT(*) FILTER(WHERE status<>'resolved' AND channel='instagram') instagram_open,
           COUNT(*) FILTER(WHERE status<>'resolved' AND channel='facebook') facebook_open,
           COUNT(*) FILTER(WHERE status<>'resolved' AND COALESCE((SELECT sm_d.direction FROM support_messages sm_d WHERE sm_d.ticket_id = support_tickets.id AND sm_d.delivery_status <> 'ai_draft' ORDER BY sm_d.created_at DESC, sm_d.id DESC LIMIT 1), 'inbound') = 'inbound') needs_reply,
           COUNT(*) FILTER(WHERE status<>'resolved' AND (first_response_at IS NULL OR COALESCE((SELECT sm_d2.direction FROM support_messages sm_d2 WHERE sm_d2.ticket_id = support_tickets.id AND sm_d2.delivery_status <> 'ai_draft' ORDER BY sm_d2.created_at DESC, sm_d2.id DESC LIMIT 1), 'inbound') = 'inbound') AND COALESCE(sla_due_at, created_at + interval '12 hours') < now()) sla_breached,
           COUNT(*) FILTER(WHERE status<>'resolved' AND ai_status IN ('needs_admin_input', 'needs_human_action')) ai_needs_admin,
           COUNT(*) FILTER(WHERE status<>'resolved' AND ai_status = 'needs_human_action') ai_human_action,
           COUNT(*) FILTER(WHERE status<>'resolved' AND ai_status = 'draft_ready') ai_drafts
         FROM support_tickets WHERE ${summaryWhere}`,
      )
      .bind(...summaryValues)
      .first<Record<string, number>>(),
    db
      .prepare(
        `SELECT a.*,
                COUNT(t.id) FILTER (WHERE t.status <> 'resolved')::int AS open_load
         FROM support_agents a
         LEFT JOIN support_tickets t ON t.assignee_id = a.user_id
         GROUP BY a.user_id
         ORDER BY a.name`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT email,last_sync_at,last_error,watch_expiration,import_complete,encrypted_refresh_token<>'' connected FROM support_mailboxes WHERE email=?",
      )
      .bind(mailbox())
      .first<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT channel,account_id,account_name,username,page_id,last_sync_at,last_error,encrypted_access_token<>'' connected FROM support_social_accounts ORDER BY channel",
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT id,name,body,macro_status,macro_priority,macro_tags,shortcut,updated_at FROM support_reply_templates ORDER BY name",
      )
      .all<Record<string, unknown>>(),
  ]);

  const agents = (agentRows.results as SupportRow[]).map(
    (a): SupportRow => ({
      ...a,
      max_open_tickets: Number(a.max_open_tickets || 25),
      preferred_channels: normalizePreferredChannels(a.preferred_channels),
      open_load: Number(a.open_load || 0),
    }),
  );

  const templates = (templateRows.results as SupportRow[]).map(
    (tpl): SupportRow => ({
      ...tpl,
      macro_status: String(tpl.macro_status || ""),
      macro_priority: String(tpl.macro_priority || ""),
      macro_tags: parseJsonArray(tpl.macro_tags),
      shortcut: String(tpl.shortcut || ""),
    }),
  );

  let selectedTicket: SupportRow | null = null;
  let messages: SupportRow[] = [];
  let events: SupportRow[] = [];
  let orders: SupportRow[] = [];
  let customer: SupportSnapshot["customer"] = {
    name: "",
    email: "",
    phone: "",
    tags: [],
  };
  let customer360: Customer360Summary = computeCustomer360([], 0);
  let linkedCustomer: SupportSnapshot["linkedCustomer"] = {
    isLinked: false,
    linkedOrderId: null,
    linkedEmail: "",
    linkedPhone: "",
    linkedName: "",
  };
  let activeViewers: SupportSnapshot["activeViewers"] = [];
  let aiEscalations: SupportRow[] = [];
  let aiThreadTokenEstimate = 0;
  let aiChatTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    requestCount: 0,
  };
  let aiChatTokenLogs: Array<{
    id: string;
    messageId: string | null;
    operationType: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    createdAt: string;
  }> = [];

  if (id) {
    selectedTicket = await db
      .prepare(
        `SELECT * FROM support_tickets WHERE id=?${canManage ? "" : " AND assignee_id=?"}`,
      )
      .bind(...(canManage ? [id] : [id, u.id]))
      .first<SupportRow>();
    if (!selectedTicket)
      throw new HttpError(404, "Ticket not found or not assigned to you");

    const channel = String(selectedTicket.channel || "email");
    const externalUserId = String(selectedTicket.external_user_id || "");
    const ticketEmail = String(selectedTicket.customer_email || "");

    const [messageRows, eventRows, savedLink, escalationRows, tokenUsageRows] = await Promise.all([
      db
        .prepare(
          `SELECT id, ticket_id, gmail_message_id, message_id, direction, sender, recipients,
                  body,
                  CASE
                    WHEN jsonb_typeof(attachments) = 'array' THEN
                      COALESCE((SELECT jsonb_agg(att - 'dataBase64') FROM jsonb_array_elements(attachments) att), '[]'::jsonb)
                    ELSE '[]'::jsonb
                  END AS attachments,
                  delivery_status, request_key, resolve_after_send, attempts, last_error,
                  created_by, created_at
           FROM support_messages
           WHERE ticket_id=?
           ORDER BY created_at,id`,
        )
        .bind(id)
        .all<Record<string, unknown>>(),
      db
        .prepare(
          "SELECT * FROM support_events WHERE ticket_id=? ORDER BY created_at",
        )
        .bind(id)
        .all<Record<string, unknown>>(),
      externalUserId
        ? db
            .prepare(
              "SELECT * FROM support_customer_links WHERE channel=? AND external_user_id=?",
            )
            .bind(channel, externalUserId)
            .first<Record<string, unknown>>()
            .catch(() => null)
        : ticketEmail &&
            !ticketEmail.endsWith("@facebook.com") &&
            !ticketEmail.startsWith("@") &&
            ticketEmail.includes("@")
          ? db
              .prepare(
                "SELECT * FROM support_customer_links WHERE channel=? AND (LOWER(external_user_id)=LOWER(?) OR LOWER(customer_email)=LOWER(?)) ORDER BY updated_at DESC LIMIT 1",
              )
              .bind(channel, ticketEmail, ticketEmail)
              .first<Record<string, unknown>>()
              .catch(() => null)
          : Promise.resolve(null),
      db
        .prepare(
          "SELECT * FROM support_ai_escalations WHERE ticket_id=? ORDER BY created_at DESC LIMIT 10",
        )
        .bind(id)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] })),
      db
        .prepare(
          `SELECT id, message_id, operation_type, provider, model,
                  input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at
           FROM support_ai_token_usage
           WHERE ticket_id=?
           ORDER BY created_at DESC
           LIMIT 60`,
        )
        .bind(id)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] })),
    ]);

    aiEscalations = escalationRows.results as SupportRow[];
    aiChatTokenLogs = (tokenUsageRows.results || []).map((r) => ({
      id: String(r.id || ""),
      messageId: r.message_id ? String(r.message_id) : null,
      operationType: String(r.operation_type || ""),
      provider: String(r.provider || ""),
      model: String(r.model || ""),
      inputTokens: Number(r.input_tokens || 0),
      outputTokens: Number(r.output_tokens || 0),
      totalTokens: Number(r.total_tokens || 0),
      estimatedCostUsd: Number(r.estimated_cost_usd || 0),
      createdAt: String(r.created_at || ""),
    }));
    aiChatTokenTotals = {
      inputTokens: aiChatTokenLogs.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: aiChatTokenLogs.reduce((s, r) => s + r.outputTokens, 0),
      totalTokens: aiChatTokenLogs.reduce((s, r) => s + r.totalTokens, 0),
      estimatedCostUsd: aiChatTokenLogs.reduce((s, r) => s + r.estimatedCostUsd, 0),
      requestCount: aiChatTokenLogs.length,
    };

    const tokenUsageByMessage = new Map<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        estimatedCostUsd: number;
        model: string;
        operationType: string;
      }
    >();
    for (const log of aiChatTokenLogs) {
      if (!log.messageId) continue;
      const existing = tokenUsageByMessage.get(log.messageId);
      if (!existing) {
        tokenUsageByMessage.set(log.messageId, {
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
          totalTokens: log.totalTokens,
          estimatedCostUsd: log.estimatedCostUsd,
          model: log.model,
          operationType: log.operationType,
        });
      } else {
        existing.inputTokens += log.inputTokens;
        existing.outputTokens += log.outputTokens;
        existing.totalTokens += log.totalTokens;
        existing.estimatedCostUsd += log.estimatedCostUsd;
      }
    }

    messages = (messageRows.results as SupportRow[]).map((m) => ({
      ...m,
      token_usage: tokenUsageByMessage.get(String(m.id)) || null,
      attachments: Array.isArray(m.attachments)
        ? m.attachments.map((att: SupportRow) => ({
            name: String(att.name || "attachment"),
            attachmentId: String(att.attachmentId || ""),
            mimeType: att.mimeType ? String(att.mimeType) : undefined,
            size: typeof att.size === "number" ? att.size : undefined,
            url: att.url ? String(att.url) : undefined,
          }))
        : [],
    }));
    events = eventRows.results as SupportRow[];
    activeViewers = activeViewersFromJson(selectedTicket.viewing_by, u.id);
    aiThreadTokenEstimate = messages
      .filter((m) => m.delivery_status !== "ai_draft")
      .reduce(
        (sum, m) => sum + estimateTokenCount(`${m.sender || ""}: ${m.body || ""}`) + 8,
        0,
      );

    const linkedOrderId =
      Number(selectedTicket.order_id || savedLink?.linked_order_id || 0) || null;
    const resolvedEmail = String(savedLink?.customer_email || ticketEmail || "").trim();
    const resolvedPhone = String(
      savedLink?.customer_phone || selectedTicket.associated_phone || "",
    ).trim();

    if (savedLink || selectedTicket.order_id || resolvedPhone) {
      linkedCustomer = {
        isLinked: Boolean(savedLink || selectedTicket.order_id),
        linkedOrderId,
        linkedEmail: String(savedLink?.customer_email || ""),
        linkedPhone: resolvedPhone,
        linkedName: String(savedLink?.customer_name || ""),
      };
    }

    const inboundText = [
      String(selectedTicket.subject || ""),
      ...messages
        .filter((m) => m.direction === "inbound")
        .map((m) => String(m.body || "")),
    ].join("\n");
    const hints = extractOrderOrPhoneHints(inboundText);

    const orderClauses: string[] = [];
    const orderParams: unknown[] = [];

    if (linkedOrderId) {
      orderClauses.push("id = ?");
      orderParams.push(linkedOrderId);
    }
    if (resolvedEmail && !resolvedEmail.endsWith("@facebook.com") && !resolvedEmail.startsWith("@") && resolvedEmail.includes("@")) {
      orderClauses.push("LOWER(customer_email) = LOWER(?)");
      orderParams.push(resolvedEmail);
    }
    if (resolvedPhone) {
      orderClauses.push("RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = RIGHT(?, 10)");
      orderParams.push(resolvedPhone);
    }
    if (!linkedOrderId && hints.orderCodes.length) {
      for (const code of hints.orderCodes) {
        orderClauses.push("UPPER(REPLACE(channel_order_id, '#', '')) = ?");
        orderParams.push(code);
      }
    }
    if (!resolvedPhone && hints.phones.length) {
      for (const phone of hints.phones) {
        orderClauses.push("RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = ?");
        orderParams.push(phone);
      }
    }

    if (orderClauses.length) {
      const orderRows = await db
        .prepare(
          `SELECT id, channel_order_id, status, awb, courier, total, payment_method, order_date,
                  customer_name, customer_email, customer_phone, customer_city, customer_state, raw_json
           FROM orders
           WHERE ${orderClauses.join(" OR ")}
           ORDER BY created_at DESC
           LIMIT 25`,
        )
        .bind(...orderParams)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] }));
      orders = (orderRows.results as SupportRow[]).map((o) => ({
        ...o,
        tracking_url: buildCourierTrackingUrl(String(o.courier || ""), String(o.awb || "")),
      }));
    }

    const primaryOrder = orders[0];
    const pastRow = await db
      .prepare(
        `SELECT COUNT(*)::int AS count FROM support_tickets
         WHERE id <> ?
           AND (
             (customer_email <> '' AND LOWER(customer_email) = LOWER(?))
             OR (? <> '' AND channel = ? AND external_user_id = ?)
           )`,
      )
      .bind(
        id,
        resolvedEmail || ticketEmail,
        externalUserId,
        channel,
        externalUserId,
      )
      .first<{ count: number }>()
      .catch(() => ({ count: 0 }));

    customer360 = computeCustomer360(orders, Number(pastRow?.count || 0));

    customer = {
      name: String(
        savedLink?.customer_name ||
          primaryOrder?.customer_name ||
          selectedTicket.customer_name ||
          "",
      ),
      email: String(
        savedLink?.customer_email ||
          primaryOrder?.customer_email ||
          ticketEmail ||
          "",
      ),
      phone: String(
        savedLink?.customer_phone ||
          selectedTicket.associated_phone ||
          primaryOrder?.customer_phone ||
          "",
      ),
      city: String(primaryOrder?.customer_city || ""),
      state: String(primaryOrder?.customer_state || ""),
      tags: [
        ...new Set([
          ...parseJsonArray(selectedTicket.tags),
          ...customerTags(primaryOrder?.raw_json),
        ]),
      ],
    };
  }

  const summary = summaryRow || {
    open: 0,
    unassigned: 0,
    escalated: 0,
    resolved: 0,
    needs_reply: 0,
    sla_breached: 0,
    ai_needs_admin: 0,
    ai_human_action: 0,
    ai_drafts: 0,
  };

  const [aiSettings, kbSummaryRow] = await Promise.all([
    getAiSettings().catch(() => undefined),
    db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE is_active = TRUE)::int AS total_docs,
           COUNT(*) FILTER (WHERE is_active = TRUE AND category = 'policy')::int AS policy_count,
           COUNT(*) FILTER (WHERE is_active = TRUE AND category = 'product')::int AS product_count,
           COUNT(*) FILTER (WHERE is_active = TRUE AND category = 'faq')::int AS faq_count,
           COUNT(*) FILTER (WHERE is_active = TRUE AND category = 'admin_memory')::int AS admin_memory_count,
           COUNT(*) FILTER (WHERE is_active = TRUE AND category = 'template')::int AS template_count,
           (SELECT COUNT(*)::int FROM support_knowledge_chunks) AS total_chunks
         FROM support_knowledge_documents`,
      )
      .first<Record<string, number>>()
      .catch(() => null),
  ]);

  return {
    tickets: (ticketRows.results as SupportRow[]).map((t) => ({
      ...t,
      tags: parseJsonArray(t.tags),
    })),
    selectedTicket: selectedTicket
      ? { ...selectedTicket, tags: parseJsonArray(selectedTicket.tags) }
      : null,
    page,
    totalPages: Math.max(1, Math.ceil(Number(totalRow?.count || 0) / 50)),
    total: Number(totalRow?.count || 0),
    summary,
    agents,
    availableAgents: agents.filter(
      (agent) => agent.role === "support_agent" && agent.available,
    ).length,
    messages,
    events,
    orders,
    customer,
    customer360,
    linkedCustomer,
    activeViewers,
    templates,
    connection: (connection || {
      email: mailbox(),
      connected: false,
    }) as SupportRow,
    socialConnections: socialRows.results as SupportRow[],
    canManage,
    userId: u.id,
    configured: Boolean(
      process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.SUPPORT_TOKEN_KEY &&
        process.env.GOOGLE_REDIRECT_URI,
    ),
    pushConfigured: Boolean(
      process.env.GMAIL_PUBSUB_TOPIC &&
        process.env.GMAIL_PUSH_SERVICE_ACCOUNT,
    ),
    metaSystemConfigured: Boolean(process.env.META_SYSTEM_USER_TOKEN),
    metaPageId: process.env.META_PAGE_ID || "",
    aiSettings,
    aiEscalations,
    aiThreadTokenEstimate,
    aiChatTokenTotals,
    aiChatTokenLogs,
    aiKnowledgeSummary: {
      totalDocuments: Number(kbSummaryRow?.total_docs || 0),
      totalChunks: Number(kbSummaryRow?.total_chunks || 0),
      policyCount: Number(kbSummaryRow?.policy_count || 0),
      productCount: Number(kbSummaryRow?.product_count || 0),
      faqCount: Number(kbSummaryRow?.faq_count || 0),
      adminMemoryCount: Number(kbSummaryRow?.admin_memory_count || 0),
      templateCount: Number(kbSummaryRow?.template_count || 0),
    },
  };
}

export async function searchCustomersAndOrders(query: string) {
  const clean = query.trim();
  if (clean.length < 3) return [];
  const db = await operationsDb();
  const pattern = `%${clean.slice(0, 120)}%`;
  const rows = await db
    .prepare(
      `SELECT id, channel_order_id, status, awb, courier, total, payment_method, order_date,
              customer_name, customer_email, customer_phone, customer_city, customer_state
       FROM orders
       WHERE channel_order_id ILIKE ?
          OR awb ILIKE ?
          OR customer_name ILIKE ?
          OR customer_email ILIKE ?
          OR customer_phone ILIKE ?
       ORDER BY created_at DESC
       LIMIT 15`,
    )
    .bind(pattern, pattern, pattern, pattern, pattern)
    .all<Record<string, unknown>>()
    .catch((err) => {
      console.warn("Customer order search failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { results: [] as Record<string, unknown>[] };
    });
  return rows.results;
}

export async function supportInsights(days = 14) {
  const db = await operationsDb();
  const safeDays = Math.max(7, Math.min(90, Math.floor(days || 14)));
  const intervalStr = `${safeDays} days`;

  const [overall, dailyRows, agentRows, tokenSummaryRow] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*)::int AS total_tickets,
           COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_count,
           ROUND(
             PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60.0
             ) FILTER (WHERE first_response_at IS NOT NULL AND first_response_at >= created_at)
           )::int AS median_frt_minutes,
           COUNT(*) FILTER (WHERE first_response_at IS NOT NULL AND sla_due_at IS NOT NULL AND first_response_at <= sla_due_at)::int AS sla_met,
           COUNT(*) FILTER (WHERE first_response_at IS NOT NULL AND sla_due_at IS NOT NULL)::int AS sla_measured,
           ROUND(AVG(csat_score)::numeric, 2) AS avg_csat,
           COUNT(csat_score)::int AS csat_count
         FROM support_tickets
         WHERE created_at >= now() - ?::interval`,
      )
      .bind(intervalStr)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT
           TO_CHAR(DATE(created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
           COUNT(*) FILTER (WHERE COALESCE(channel, 'email') = 'email')::int AS email,
           COUNT(*) FILTER (WHERE channel = 'facebook')::int AS facebook,
           COUNT(*) FILTER (WHERE channel = 'instagram')::int AS instagram
         FROM support_tickets
         WHERE created_at >= now() - ?::interval
         GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
         ORDER BY day ASC`,
      )
      .bind(intervalStr)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT
           a.user_id,
           a.name,
           a.email,
           a.role,
           a.available,
           COALESCE(a.max_open_tickets, 25)::int AS max_open_tickets,
           a.preferred_channels,
           COUNT(t.id) FILTER (WHERE t.status <> 'resolved')::int AS open_load,
           COUNT(t.id) FILTER (WHERE t.status = 'resolved' AND t.resolved_at >= now() - ?::interval)::int AS resolved_period,
           ROUND(
             PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60.0
             ) FILTER (WHERE t.first_response_at IS NOT NULL AND t.first_response_at >= t.created_at)
           )::int AS median_frt_minutes,
           ROUND(AVG(t.csat_score)::numeric, 2) AS avg_csat
         FROM support_agents a
         LEFT JOIN support_tickets t ON t.assignee_id = a.user_id
         GROUP BY a.user_id, a.name, a.email, a.role, a.available, a.max_open_tickets, a.preferred_channels
         ORDER BY open_load DESC, a.name ASC`,
      )
      .bind(intervalStr)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT
           COUNT(*)::int AS request_count,
           COUNT(DISTINCT ticket_id) FILTER (WHERE ticket_id IS NOT NULL)::int AS chats_count,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(estimated_cost_usd), 0)::float8 AS total_cost_usd
         FROM support_ai_token_usage
         WHERE created_at >= now() - ?::interval`,
      )
      .bind(intervalStr)
      .first<Record<string, unknown>>()
      .catch(() => null),
  ]);

  const totalTickets = Number(overall?.total_tickets || 0);
  const resolvedCount = Number(overall?.resolved_count || 0);
  const slaMet = Number(overall?.sla_met || 0);
  const slaMeasured = Number(overall?.sla_measured || 0);

  return {
    days: safeDays,
    totalTickets,
    resolvedCount,
    resolutionRate: totalTickets ? Math.round((resolvedCount / totalTickets) * 100) : 0,
    medianFrtMinutes: overall?.median_frt_minutes != null ? Number(overall.median_frt_minutes) : null,
    slaCompliancePercent: slaMeasured ? Math.round((slaMet / slaMeasured) * 100) : null,
    avgCsatScore: overall?.avg_csat != null ? Number(overall.avg_csat) : null,
    csatCount: Number(overall?.csat_count || 0),
    tokenSummary: {
      requestCount: Number(tokenSummaryRow?.request_count || 0),
      chatsCount: Number(tokenSummaryRow?.chats_count || 0),
      inputTokens: Number(tokenSummaryRow?.input_tokens || 0),
      outputTokens: Number(tokenSummaryRow?.output_tokens || 0),
      totalTokens: Number(tokenSummaryRow?.total_tokens || 0),
      totalCostUsd: Number(tokenSummaryRow?.total_cost_usd || 0),
    },
    dailyVolume: dailyRows.results.map((r) => ({
      day: String(r.day),
      email: Number(r.email || 0),
      facebook: Number(r.facebook || 0),
      instagram: Number(r.instagram || 0),
    })),
    agentStats: agentRows.results.map((a) => ({
      userId: String(a.user_id),
      name: String(a.name || a.email || ""),
      email: String(a.email || ""),
      role: String(a.role || ""),
      available: Boolean(a.available),
      maxOpenTickets: Number(a.max_open_tickets || 25),
      preferredChannels: normalizePreferredChannels(a.preferred_channels),
      openLoad: Number(a.open_load || 0),
      resolvedPeriod: Number(a.resolved_period || 0),
      medianFrtMinutes: a.median_frt_minutes != null ? Number(a.median_frt_minutes) : null,
      avgCsat: a.avg_csat != null ? Number(a.avg_csat) : null,
    })),
  };
}

export async function getCsatContext(token: string) {
  const clean = token.trim();
  if (!clean || clean.length < 12) return null;
  const db = await operationsDb();
  const row = await db
    .prepare(
      `SELECT ticket_number, customer_name, channel, csat_score, csat_comment, csat_submitted_at, csat_expires_at
       FROM support_tickets
       WHERE csat_token = ?
         AND (csat_expires_at IS NULL OR csat_expires_at > now())`,
    )
    .bind(clean)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const rawName = String(row.customer_name || "").trim();
  const firstName = rawName && !rawName.includes("@") ? rawName.split(/\s+/)[0] : "";
  return {
    ticket_number: row.ticket_number,
    customer_name: firstName,
    channel: row.channel,
    csat_score: row.csat_score,
    csat_comment: row.csat_submitted_at ? row.csat_comment : "",
    csat_submitted_at: row.csat_submitted_at,
  };
}

export async function submitCsatRating(
  token: string,
  score: number,
  comment: string,
) {
  const clean = token.trim();
  const safeScore = Math.round(Number(score));
  if (!clean || clean.length < 12 || !Number.isInteger(safeScore) || safeScore < 1 || safeScore > 5) {
    throw new HttpError(400, "Select a rating between 1 and 5 stars");
  }
  const db = await operationsDb();
  return db.transaction(async (sql) => {
    const [existing] = await sql`
      SELECT id, csat_submitted_at, csat_expires_at
      FROM support_tickets
      WHERE csat_token = ${clean}
      FOR UPDATE
    `;
    if (!existing) throw new HttpError(404, "Feedback link was not found or expired");
    if (existing.csat_expires_at && new Date(String(existing.csat_expires_at)).getTime() <= Date.now()) {
      throw new HttpError(410, "This feedback link has expired");
    }
    if (existing.csat_submitted_at) {
      throw new HttpError(409, "Feedback has already been submitted for this case");
    }
    const [t] = await sql`
      UPDATE support_tickets
      SET csat_score = ${safeScore},
          csat_comment = ${String(comment || "").trim().slice(0, 1000)},
          csat_submitted_at = now()
      WHERE id = ${existing.id}
      RETURNING id, ticket_number, csat_score, csat_comment, csat_submitted_at
    `;
    await supportEvent(sql, "customer", String(t.id), "csat_submitted", {
      score: safeScore,
    });
    return t;
  });
}

export async function mutateSupport(
  b: Record<string, unknown>,
  u: DashboardUser,
  options: { appOrigin?: string } = {},
) {
  const db = await operationsDb();
  return db.transaction(async (sql) => {
    if (
      ["template_create", "template_update", "template_delete"].includes(
        String(b.action),
      )
    ) {
      if (!manager(u))
        throw new HttpError(
          403,
          "Manager access required to manage shared templates",
        );
      if (b.action === "template_delete") {
        await sql`DELETE FROM support_reply_templates WHERE id=${required(b.templateId, "Template")}`;
        return { ok: true };
      }
      const name = required(b.name, "Template name").slice(0, 80);
      const body = required(b.body, "Template message").slice(0, 10000);
      const macroStatus = ["", "open", "in_progress", "waiting", "escalated", "resolved"].includes(
        String(b.macroStatus || ""),
      )
        ? String(b.macroStatus || "")
        : "";
      const macroPriority = ["", "low", "normal", "high", "urgent"].includes(
        String(b.macroPriority || ""),
      )
        ? String(b.macroPriority || "")
        : "";
      const macroTags = Array.isArray(b.macroTags)
        ? [...new Set(b.macroTags.map((x) => String(x).trim()).filter(Boolean))].slice(0, 8)
        : String(b.macroTags || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 8);
      const shortcut = String(b.shortcut || "")
        .replace(/^\//, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 24);

      if (b.action === "template_create") {
        await sql`
          INSERT INTO support_reply_templates(id,name,body,macro_status,macro_priority,macro_tags,shortcut,created_by,updated_by)
          VALUES(${randomUUID()},${name},${body},${macroStatus},${macroPriority},${sql.json(macroTags)},${shortcut},${u.id},${u.id})
        `;
      } else {
        await sql`
          UPDATE support_reply_templates
          SET name=${name},body=${body},macro_status=${macroStatus},macro_priority=${macroPriority},macro_tags=${sql.json(macroTags)},shortcut=${shortcut},updated_by=${u.id},updated_at=now()
          WHERE id=${required(b.templateId, "Template")}
        `;
      }
      return { ok: true };
    }

    if (b.action === "bulk_assign") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const ids = Array.isArray(b.ticketIds)
        ? [
            ...new Set(
              b.ticketIds
                .map(String)
                .filter((id) => /^[a-z0-9-]{8,}$/i.test(id)),
            ),
          ].slice(0, 50)
        : [];
      if (!ids.length) throw new HttpError(400, "Select at least one ticket");
      const target = required(b.agentId, "Support agent");
      const [agent] =
        await sql`SELECT user_id FROM support_agents WHERE user_id=${target} AND available`;
      if (!agent) throw new HttpError(400, "Select an available support agent");
      const updated =
        await sql`UPDATE support_tickets SET assignee_id=${target},version=version+1,updated_at=now() WHERE id IN ${sql(ids)} RETURNING id`;
      for (const row of updated)
        await supportEvent(sql, u.id, String(row.id), "bulk_assigned", {
          agentId: target,
        });
      return { ok: true, updated: updated.length };
    }

    if (b.action === "availability") {
      if (!manager(u) && String(b.agentId) !== u.id)
        throw new HttpError(403, "Manager access required");
      await sql`UPDATE support_agents SET available=${b.available === true} WHERE user_id=${String(b.agentId)}`;
      if (b.available === true) await assignWaitingTickets(sql);
      return { ok: true };
    }

    if (b.action === "agent_settings") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const agentId = required(b.agentId, "Agent");
      const maxOpen = Math.max(1, Math.min(200, Math.round(Number(b.maxOpenTickets || 25))));
      const channels = normalizePreferredChannels(b.preferredChannels);
      await sql`
        UPDATE support_agents
        SET max_open_tickets = ${maxOpen},
            preferred_channels = ${sql.json(channels)}
        WHERE user_id = ${agentId}
      `;
      await assignWaitingTickets(sql);
      return { ok: true, notice: "Agent capacity & channel routing updated." };
    }

    if (b.action === "create") {
      const ch = ["email", "instagram", "facebook"].includes(String(b.channel || "email"))
        ? String(b.channel || "email")
        : "email";
      const contact = required(b.email, ch === "email" ? "Customer email" : "Customer handle / name");
      if (ch === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))
        throw new HttpError(400, "Enter a valid customer email");
      const requestKey = required(b.requestKey, "Request key");
      await sql`SELECT pg_advisory_xact_lock(hashtext(${"manual:" + requestKey}))`;
      const [existing] =
        await sql`SELECT id FROM support_tickets WHERE mailbox=${mailbox()} AND gmail_thread_id=${"manual:" + requestKey}`;
      if (existing) return { id: existing.id };
      await sql`INSERT INTO support_mailboxes(email,connected_by) VALUES(${mailbox()},${u.id}) ON CONFLICT(email) DO NOTHING`;
      const id = randomUUID();
      const extUserId = String(b.externalUserId || (ch !== "email" ? `${ch}_${id.slice(0, 8)}` : ""));
      const extUsername = String(b.externalUsername || (ch !== "email" ? contact : ""));
      const custName = String(b.customerName || extUsername || "");
      const slaDue = computeSlaDueAt(new Date(), "normal");
      await sql`
        INSERT INTO support_tickets(id,mailbox,gmail_thread_id,subject,customer_email,customer_name,channel,external_user_id,external_username,last_inbound_at,sla_due_at)
        VALUES(${id},${mailbox()},${"manual:" + requestKey},${required(b.subject, "Subject")},${contact},${custName},${ch},${extUserId},${extUsername},now(),${slaDue}::timestamptz)
      `;
      await sql`INSERT INTO support_messages(id,ticket_id,direction,sender,recipients,body,delivery_status,created_by) VALUES(${randomUUID()},${id},'inbound',${custName || contact},${ch === "email" ? mailbox() : ch},${required(b.query, "Customer query")},'received',${u.id})`;
      await assignWaitingTickets(sql);
      const [assignedTicket] = await sql`SELECT assignee_id FROM support_tickets WHERE id=${id}`;
      await supportEvent(sql, u.id, id, "created_manually", {
        assigned: assignedTicket?.assignee_id || null,
        channel: ch,
      });
      return { id };
    }

    const id = required(b.ticketId, "Ticket");
    const isViewing = b.action === "viewing";
    const t = await ticketAccess(sql, id, u, !isViewing);

    // Lightweight presence heartbeat does not mutate version
    if (isViewing) {
      const curr =
        t.viewing_by && typeof t.viewing_by === "object" && !Array.isArray(t.viewing_by)
          ? { ...(t.viewing_by as Record<string, { name?: string; at?: string }>) }
          : {};
      const cutoff = Date.now() - 45_000;
      for (const [uid, info] of Object.entries(curr)) {
        const ts = new Date(String(info?.at || "")).getTime();
        if (!Number.isFinite(ts) || ts < cutoff) delete curr[uid];
      }
      if (b.leaving === true) {
        delete curr[u.id];
      } else {
        curr[u.id] = { name: u.name || u.email, at: new Date().toISOString() };
      }
      await sql`UPDATE support_tickets SET viewing_by=${sql.json(curr)} WHERE id=${id}`;
      return {
        ok: true,
        activeViewers: activeViewersFromJson(curr, u.id),
      };
    }

    if (["reply", "note"].includes(String(b.action)) && b.requestKey) {
      const [existing] =
        await sql`SELECT id FROM support_messages WHERE ticket_id=${id} AND request_key=${String(b.requestKey)}`;
      if (existing) return { id: existing.id };
    }

    if (Number(b.version) !== t.version)
      throw new HttpError(
        409,
        "This ticket was updated by another teammate. Refresh before saving or replying.",
      );

    const action = String(b.action);
    let messageId = "";

    if (action === "assign") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const target = String(b.agentId || "");
      if (target) {
        const [a] =
          await sql`SELECT * FROM support_agents WHERE user_id=${target} AND available`;
        if (!a) throw new HttpError(400, "Select an available agent");
      }
      await sql`UPDATE support_tickets SET assignee_id=${target || null} WHERE id=${id}`;
    } else if (action === "escalate") {
      const reason = required(b.reason, "Escalation reason");
      const [m] =
        await sql`SELECT * FROM support_agents WHERE role IN ('support_manager','admin') AND available ORDER BY CASE WHEN user_id=${String(b.agentId || "")} THEN 0 ELSE 1 END,role DESC LIMIT 1`;
      if (!m)
        throw new HttpError(
          409,
          "No manager is available; ask an admin to configure a support manager",
        );
      await sql`UPDATE support_tickets SET status='escalated',resolved_at=NULL,assignee_id=${m.user_id} WHERE id=${id}`;
      await supportEvent(sql, u.id, id, "escalation_reason", {
        reason,
        manager: m.email,
      });
    } else if (action === "status") {
      if (
        !["open", "in_progress", "waiting", "resolved"].includes(
          String(b.status),
        )
      )
        throw new HttpError(400, "Invalid status");
      const nextStatus = String(b.status);
      const nextSlaDue =
        nextStatus !== "resolved" && t.status === "resolved"
          ? computeSlaDueAt(new Date(), String(t.priority || "normal"))
          : null;
      await sql`
        UPDATE support_tickets
        SET status=${nextStatus},
            resolved_at=CASE WHEN ${nextStatus === "resolved"} THEN COALESCE(resolved_at, now()) ELSE NULL END,
            sla_due_at=COALESCE(${nextSlaDue}::timestamptz, sla_due_at),
            assignee_id=COALESCE(assignee_id,${u.id})
        WHERE id=${id}
      `;
    } else if (action === "priority") {
      if (!["low", "normal", "high", "urgent"].includes(String(b.priority)))
        throw new HttpError(400, "Invalid priority");
      const nextPriority = String(b.priority);
      const nextSlaDue = computeSlaDueAt(
        t.created_at || new Date(),
        nextPriority,
      );
      await sql`
        UPDATE support_tickets
        SET priority=${nextPriority},
            sla_due_at=${nextSlaDue}::timestamptz,
            assignee_id=COALESCE(assignee_id,${u.id})
        WHERE id=${id}
      `;
    } else if (action === "link_customer") {
      const orderId = b.orderId ? Number(b.orderId) : null;
      const customerEmail = String(b.customerEmail || "").trim();
      const customerPhone = String(b.customerPhone || "").trim();
      const customerName = String(b.customerName || "").trim();
      if (!orderId && !customerEmail && !customerPhone) {
        throw new HttpError(400, "Select an order or customer profile to link");
      }

      if (orderId || customerPhone) {
        await sql`
          UPDATE support_tickets
          SET order_id = COALESCE(${orderId}, order_id),
              associated_phone = CASE WHEN ${customerPhone} <> '' THEN ${customerPhone} ELSE associated_phone END
          WHERE id = ${id}
        `;
      }

      const channel = String(t.channel || "email");
      const extKey = String(t.external_user_id || t.customer_email || id);
      if (extKey) {
        await sql`
          INSERT INTO support_customer_links(channel,external_user_id,customer_email,customer_phone,customer_name,linked_order_id,updated_at)
          VALUES(${channel},${extKey},${customerEmail},${customerPhone},${customerName},${orderId},now())
          ON CONFLICT(channel,external_user_id) DO UPDATE
          SET customer_email = EXCLUDED.customer_email,
              customer_phone = EXCLUDED.customer_phone,
              customer_name = EXCLUDED.customer_name,
              linked_order_id = COALESCE(EXCLUDED.linked_order_id, support_customer_links.linked_order_id),
              updated_at = now()
        `;
      }
      await supportEvent(sql, u.id, id, "customer_linked", {
        orderId,
        customerEmail,
        customerPhone,
      });
    } else if (action === "unlink_customer") {
      const channel = String(t.channel || "email");
      const extKey = String(t.external_user_id || t.customer_email || id);
      await sql`UPDATE support_tickets SET order_id=NULL WHERE id=${id}`;
      await sql`DELETE FROM support_customer_links WHERE channel=${channel} AND external_user_id=${extKey}`;
    } else if (action === "note" || action === "reply") {
      const rawAttachments = Array.isArray(b.attachments) ? b.attachments : [];
      const attachments: Array<{
        attachmentId: string;
        name: string;
        mimeType: string;
        size: number;
        dataBase64: string;
      }> = [];
      let totalBytes = 0;

      for (const rawAtt of rawAttachments.slice(0, 5)) {
        if (!rawAtt || typeof rawAtt !== "object") continue;
        const attObj = rawAtt as Record<string, unknown>;
        const name = String(attObj.name || "attachment").slice(0, 180);
        const mimeType = String(attObj.mimeType || "application/octet-stream").slice(0, 120);
        const dataBase64 = String(attObj.dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
        if (!dataBase64) continue;
        const size = Buffer.byteLength(dataBase64, "base64");
        if (size > 4 * 1024 * 1024) {
          throw new HttpError(400, `Attachment "${name}" exceeds the 4 MB per-file limit`);
        }
        totalBytes += size;
        if (totalBytes > 10 * 1024 * 1024) {
          throw new HttpError(400, "Total attachment size exceeds 10 MB");
        }
        attachments.push({
          attachmentId: randomUUID(),
          name,
          mimeType,
          size,
          dataBase64,
        });
      }

      const rawText = String(b.body ?? "").trim();
      let body =
        action === "note"
          ? required(rawText, "Note")
          : rawText || (attachments.length ? "" : required(rawText, "Message"));
      const key = required(b.requestKey, "Request key");
      const [old] =
        await sql`SELECT id FROM support_messages WHERE request_key=${key}`;
      if (old) return { id: old.id, messageId: old.id };
      messageId = randomUUID();
      const isSocial = ["instagram", "facebook"].includes(String(t.channel || ""));
      const senderLabel =
        action === "note"
          ? u.email
          : isSocial
            ? u.name || u.email
            : mailbox();

      const macroStatus = ["open", "in_progress", "waiting", "escalated", "resolved"].includes(
        String(b.macroStatus || ""),
      )
        ? String(b.macroStatus)
        : "";
      const macroPriority = ["low", "normal", "high", "urgent"].includes(
        String(b.macroPriority || ""),
      )
        ? String(b.macroPriority)
        : "";
      const macroTags = Array.isArray(b.macroTags)
        ? b.macroTags.map((x) => String(x).trim()).filter(Boolean)
        : [];
      const resolveAfterSend = b.resolve === true || macroStatus === "resolved";

      let csatToken = String(t.csat_token || "");
      if (action === "reply" && resolveAfterSend) {
        if (!csatToken) {
          csatToken = randomUUID().replace(/-/g, "").slice(0, 20);
        }
        if (options.appOrigin && body && !body.includes(`/csat/${csatToken}`)) {
          body = `${body}\n\nRate your Satmi Support experience: ${options.appOrigin}/csat/${csatToken}`;
        }
      }

      await sql`
        INSERT INTO support_messages(id,ticket_id,message_id,direction,sender,recipients,body,attachments,delivery_status,request_key,resolve_after_send,created_by)
        VALUES(${messageId},${id},${"<" + randomUUID() + "@satmi.in>"},${action === "note" ? "note" : "outbound"},${senderLabel},${action === "note" ? "" : (isSocial ? t.customer_email : (t.reply_to_email || t.customer_email))},${body},${sql.json(attachments)},${action === "note" ? "note" : "queued"},${key},${resolveAfterSend},${u.id})
      `;

      if (action === "reply") {
        // Clean up any staged ai_draft messages and close pending AI escalations when a human replies
        await sql`DELETE FROM support_messages WHERE ticket_id = ${id} AND delivery_status = 'ai_draft'`;
        await sql`
          UPDATE support_ai_escalations
          SET status = 'answered',
              answered_by = ${u.id},
              answered_at = now()
          WHERE ticket_id = ${id} AND status = 'pending'
        `;
        const mergedTags = [...new Set([...parseJsonArray(t.tags), ...macroTags])].slice(0, 12);
        const nextStatus = macroStatus || String(t.status || "open");
        const nextPriority = macroPriority || String(t.priority || "normal");
        const nextSlaDue = macroPriority
          ? computeSlaDueAt(t.created_at || new Date(), nextPriority)
          : t.sla_due_at;
        await sql`
          UPDATE support_tickets
          SET assignee_id = COALESCE(assignee_id, ${u.id}),
              first_response_at = COALESCE(first_response_at, now()),
              status = ${resolveAfterSend ? "resolved" : nextStatus},
              resolved_at = CASE WHEN ${resolveAfterSend} THEN COALESCE(resolved_at, now()) ELSE resolved_at END,
              priority = ${nextPriority},
              sla_due_at = ${nextSlaDue || null}::timestamptz,
              tags = ${sql.json(mergedTags)},
              csat_token = COALESCE(csat_token, ${csatToken || null}),
              csat_expires_at = CASE WHEN ${Boolean(csatToken)} AND csat_expires_at IS NULL THEN now() + interval '30 days' ELSE csat_expires_at END,
              ai_status = 'idle'
          WHERE id = ${id}
        `;
      } else if (!t.assignee_id) {
        await sql`UPDATE support_tickets SET assignee_id=${u.id} WHERE id=${id}`;
      }
    } else if (action === "ai_discard_draft") {
      await sql`DELETE FROM support_messages WHERE ticket_id = ${id} AND delivery_status = 'ai_draft'`;
      await sql`UPDATE support_tickets SET ai_status = 'idle' WHERE id = ${id}`;
    } else if (action === "retry") {
      const [m] =
        await sql`SELECT * FROM support_messages WHERE id=${String(b.messageId)} AND ticket_id=${id} FOR UPDATE`;
      if (!m || m.delivery_status !== "failed")
        throw new HttpError(409, "Only confirmed failed sends may be retried");
      messageId = String(m.id);
      await sql`UPDATE support_messages SET delivery_status='queued',send_started_at=NULL,last_error='' WHERE id=${m.id}`;
    } else if (action === "delete_ticket") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      await sql`DELETE FROM support_events WHERE ticket_id=${id}`;
      await sql`DELETE FROM support_messages WHERE ticket_id=${id}`;
      await sql`DELETE FROM support_tickets WHERE id=${id}`;
      return { ok: true, deleted: true, notice: "Ticket removed." };
    } else throw new HttpError(400, "Unknown support action");

    await sql`UPDATE support_tickets SET version=version+1,updated_at=now() WHERE id=${id}`;
    await supportEvent(sql, u.id, id, action, {
      status: b.status || b.macroStatus || null,
      agentId: b.agentId || null,
    });
    return { ok: true, ...(messageId ? { messageId } : {}) };
  });
}
