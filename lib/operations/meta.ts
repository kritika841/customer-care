import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http";
import { decrypt as decryptToken, encrypt as encryptToken } from "./gmail";
import { operationsDb } from "./schema";
import { assignWaitingTickets, mailbox, supportEvent } from "./support";
import { checkAiLiveOutboundGate } from "./ai-gate";
import { computeSlaDueAt } from "./sla";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const IG_GRAPH_BASE = "https://graph.instagram.com/v21.0";
const SYNC_LOOKBACK_DAYS = 30;

type GraphIgAccount = {
  id: string;
  name?: string;
  username?: string;
};

type GraphPageInfo = {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: GraphIgAccount;
  connected_instagram_account?: GraphIgAccount;
};

type GraphMessageItem = {
  id: string;
  created_time?: string;
  from?: { id: string; name?: string; username?: string; email?: string };
  to?: { data?: Array<{ id: string; name?: string; username?: string }> };
  message?: string;
  attachments?: {
    data?: Array<{
      id: string;
      mime_type?: string;
      name?: string;
      file_url?: string;
      image_data?: { url?: string };
    }>;
  };
};

type GraphConversation = {
  id: string;
  updated_time?: string;
  participants?: {
    data?: Array<{ id: string; name?: string; username?: string; email?: string }>;
  };
  messages?: {
    data?: GraphMessageItem[];
    paging?: { next?: string };
  };
};

function stripAccessTokenFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete("access_token");
    return u.toString();
  } catch {
    return rawUrl.replace(/([?&])access_token=[^&]+(&|$)/g, "$1").replace(/[?&]$/, "");
  }
}

function redactMetaError(msg: string): string {
  return String(msg || "").replace(/access_token=[^&\s"']+/gi, "access_token=[REDACTED]");
}

async function graphGetUrl<T>(fullUrl: string, accessToken: string, timeoutMs = 25000): Promise<T> {
  const cleanUrl = stripAccessTokenFromUrl(fullUrl);
  const res = await fetch(cleanUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string };
  };
  if (!res.ok || data?.error) {
    if (data?.error?.error_subcode === 2534084) {
      throw new HttpError(
        400,
        "Instagram inbox scan timed out in Development Mode (Standard Access) because @satmi.in has many customer threads. Switch Satmi Support to Live Mode with Advanced Access for instagram_manage_messages (or use /api/support/meta/webhook for Tester DMs)."
      );
    }
    throw new HttpError(
      400,
      redactMetaError(data?.error?.message || `Meta Graph API request failed (${res.status})`)
    );
  }
  return data;
}

async function graphGet<T>(
  path: string,
  accessToken: string,
  base = GRAPH_BASE,
  timeoutMs = 25000
): Promise<T> {
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  return graphGetUrl<T>(url.toString(), accessToken, timeoutMs);
}

async function ensureDefaultMailboxRow() {
  const db = await operationsDb();
  await db
    .prepare(
      `INSERT INTO support_mailboxes (email, connected_by)
       VALUES (?, 'system')
       ON CONFLICT (email) DO NOTHING`
    )
    .bind(mailbox())
    .run();
}

export function getConfiguredMetaSystemToken() {
  return (process.env.META_SYSTEM_USER_TOKEN || "").trim();
}

async function resolveAssignedPages(token: string, preferredPageId?: string): Promise<GraphPageInfo[]> {
  const richFields =
    "id,name,access_token,instagram_business_account{id,name,username},connected_instagram_account{id,name,username}";
  const basicFields = "id,name,access_token";
  const pageMap = new Map<string, GraphPageInfo>();

  for (const endpoint of [
    `/me/accounts?fields=${richFields}`,
    `/me/accounts?fields=${basicFields}`,
    `/me/assigned_pages?fields=${richFields}`,
    `/me/assigned_pages?fields=${basicFields}`,
  ]) {
    try {
      const res = await graphGet<{ data?: GraphPageInfo[] }>(endpoint, token);
      for (const page of res.data || []) {
        if (!page.id) continue;
        const existing = pageMap.get(page.id);
        pageMap.set(page.id, existing ? { ...existing, ...page } : page);
      }
    } catch {
      // Endpoint or optional IG fields may not be granted yet
    }
  }

  const targetId = (preferredPageId || process.env.META_PAGE_ID || "").trim();
  if (targetId && (!pageMap.has(targetId) || !pageMap.get(targetId)?.instagram_business_account)) {
    for (const endpoint of [
      `/${encodeURIComponent(targetId)}?fields=${richFields}`,
      `/${encodeURIComponent(targetId)}?fields=${basicFields}`,
    ]) {
      try {
        const directPage = await graphGet<GraphPageInfo>(endpoint, token);
        if (directPage?.id) {
          const existing = pageMap.get(directPage.id);
          pageMap.set(directPage.id, existing ? { ...existing, ...directPage } : directPage);
          break;
        }
      } catch {
        // Direct lookup not permitted for this token
      }
    }
  }

  return Array.from(pageMap.values());
}

async function inspectGrantedPermissions(token: string): Promise<Set<string>> {
  try {
    const res = await graphGet<{ data?: Array<{ permission: string; status: string }> }>(
      "/me/permissions",
      token
    );
    return new Set(
      (res.data || [])
        .filter((p) => p.status === "granted")
        .map((p) => p.permission)
    );
  } catch {
    return new Set();
  }
}

export async function listMetaPages(rawToken?: string) {
  const token = (rawToken || getConfiguredMetaSystemToken()).trim();
  if (!token) throw new HttpError(400, "Meta System User token is not configured");
  const pages = await resolveAssignedPages(token);
  return pages.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    instagram: p.instagram_business_account || p.connected_instagram_account || null,
  }));
}

/**
 * Connects Facebook Page & linked Instagram Business Account using a Meta System User Token
 * (or Page/User Access Token).
 */
export async function connectMetaToken(
  rawToken: string | undefined,
  userId: string,
  preferredPageId?: string
) {
  const token = (rawToken || getConfiguredMetaSystemToken()).trim();
  if (!token) {
    throw new HttpError(400, "Meta System User token is required (configure META_SYSTEM_USER_TOKEN or paste a token)");
  }

  if (token.startsWith("IG")) {
    const igMe = await graphGet<{ id?: string; user_id?: string; username?: string; name?: string }>(
      "/me?fields=id,user_id,username,name",
      token,
      IG_GRAPH_BASE
    );
    const igAccountId = String(igMe.user_id || igMe.id || "");
    if (!igAccountId) {
      throw new HttpError(400, "Could not resolve Instagram account from Instagram Login token");
    }
    const handle = igMe.username ? `@${igMe.username.replace(/^@/, "")}` : igMe.name || "Instagram";
    const db = await operationsDb();
    await ensureDefaultMailboxRow();
    await db
      .prepare(
        `INSERT INTO support_social_accounts (
           channel, account_id, account_name, username, page_id, encrypted_access_token, last_error, connected_by, updated_at
         ) VALUES ('instagram', ?, ?, ?, 'ig_login', ?, '', ?, NOW())
         ON CONFLICT (channel) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           account_name = EXCLUDED.account_name,
           username = EXCLUDED.username,
           page_id = EXCLUDED.page_id,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           last_error = '',
           connected_by = EXCLUDED.connected_by,
           updated_at = NOW()`
      )
      .bind(igAccountId, igMe.name || handle, handle, encryptToken(token), userId)
      .run();

    return {
      facebookPage: { id: "", name: "" },
      instagramAccount: { id: igAccountId, username: handle },
      availablePages: [],
      missingPermissions: [],
    };
  }

  const targetPageId = (preferredPageId || process.env.META_PAGE_ID || "").trim();
  const pages = await resolveAssignedPages(token, targetPageId);
  let pageInfo: GraphPageInfo | null = null;

  if (pages.length > 0) {
    pageInfo =
      (targetPageId ? pages.find((p) => p.id === targetPageId) : undefined) ||
      pages.find((p) => p.instagram_business_account || p.connected_instagram_account) ||
      pages.find((p) => p.name?.toLowerCase().includes("satmi")) ||
      pages[0] ||
      null;
  }

  if (!pageInfo) {
    let me: (GraphPageInfo & { category?: string }) | null = null;
    try {
      me = await graphGet<GraphPageInfo & { category?: string }>(
        "/me?fields=id,name,category,instagram_business_account{id,name,username},connected_instagram_account{id,name,username}",
        token
      );
    } catch {
      try {
        me = await graphGet<GraphPageInfo & { category?: string }>("/me?fields=id,name,category", token);
      } catch {
        try {
          me = await graphGet<GraphPageInfo & { category?: string }>("/me?fields=id,name", token);
        } catch {
          const convProbe = await graphGet<{
            data?: GraphConversation[];
            paging?: { next?: string };
          }>("/me/conversations?platform=messenger&limit=1&fields=id,participants", token).catch(
            () => null
          );
          if (convProbe?.data) {
            const nextUrl = convProbe.paging?.next || "";
            const nextMatch = nextUrl.match(/\/v[\d.]+\/(\d+)\/conversations/);
            const targetId = nextMatch?.[1] || targetPageId || "";
            const allParticipants = convProbe.data[0]?.participants?.data || [];
            const pageParticipant =
              (targetId ? allParticipants.find((p) => p.id === targetId) : undefined) ||
              allParticipants.find((p) => p.email?.endsWith("@facebook.com") && p.id === targetId) ||
              allParticipants.find((p) => p.name?.toLowerCase().includes("satmi"));
            const resolvedId = pageParticipant?.id || targetId;
            if (resolvedId) {
              me = {
                id: resolvedId,
                name: pageParticipant?.name || "Satmi",
                category: "Facebook Page",
              };
            }
          }
        }
      }
    }
    if (!me?.id) throw new HttpError(400, "Could not resolve Facebook Page from Meta token");
    if (!me.category) {
      throw new HttpError(
        400,
        "This User token has no Facebook Pages selected (/me/accounts is empty). Choose your 'Satmi' Page & Instagram account, then retry."
      );
    }
    pageInfo = { ...me, access_token: token };
  }

  const pageAccessToken = pageInfo.access_token || token;
  const encrypted = encryptToken(pageAccessToken);
  const granted = await inspectGrantedPermissions(token);

  const missingFbPerms = ["pages_messaging", "pages_manage_metadata"].filter(
    (p) => granted.size > 0 && !granted.has(p)
  );
  const missingIgPerms = ["instagram_basic", "instagram_manage_messages"].filter(
    (p) => granted.size > 0 && !granted.has(p)
  );

  let ig =
    pageInfo.instagram_business_account ||
    pageInfo.connected_instagram_account ||
    null;

  if (!ig) {
    try {
      const assignedIg = await graphGet<{ data?: GraphIgAccount[] }>(
        "/me/assigned_instagram_accounts?fields=id,username,name",
        token
      );
      if (assignedIg.data && assignedIg.data.length > 0) {
        ig = assignedIg.data[0];
      }
    } catch {
      // Requires instagram_basic permission on System User token
    }
  }

  const fbWarning = missingFbPerms.length
    ? `Connected to ${pageInfo.name || "Facebook Page"}, but System User token is missing permissions: ${missingFbPerms.join(", ")}`
    : "";
  const igWarning = missingIgPerms.length
    ? `System User token needs ${missingIgPerms.join(", ")} (and assigned Instagram asset in Business Manager) to pull/reply to Instagram DMs.`
    : "";

  const db = await operationsDb();
  await ensureDefaultMailboxRow();

  await db
    .prepare(
      `INSERT INTO support_social_accounts (
         channel, account_id, account_name, username, page_id, encrypted_access_token, last_error, connected_by, updated_at
       ) VALUES ('facebook', ?, ?, ?, ?, ?, ?, ?, NOW())
       ON CONFLICT (channel) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         account_name = EXCLUDED.account_name,
         username = EXCLUDED.username,
         page_id = EXCLUDED.page_id,
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         last_error = EXCLUDED.last_error,
         connected_by = EXCLUDED.connected_by,
         updated_at = NOW()`
    )
    .bind(
      pageInfo.id,
      pageInfo.name || "Facebook Page",
      pageInfo.name || "Facebook Page",
      pageInfo.id,
      encrypted,
      fbWarning,
      userId
    )
    .run();

  const existingIg = await db
    .prepare("SELECT page_id FROM support_social_accounts WHERE channel='instagram'")
    .first<{ page_id?: string }>();

  if (ig?.id || (granted.size > 0 && existingIg?.page_id !== "ig_login")) {
    await db
      .prepare(
        `INSERT INTO support_social_accounts (
           channel, account_id, account_name, username, page_id, encrypted_access_token, last_error, connected_by, updated_at
         ) VALUES ('instagram', ?, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (channel) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           account_name = EXCLUDED.account_name,
           username = EXCLUDED.username,
           page_id = EXCLUDED.page_id,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           last_error = EXCLUDED.last_error,
           connected_by = EXCLUDED.connected_by,
           updated_at = NOW()`
      )
      .bind(
        ig?.id || "",
        ig?.name || ig?.username || (pageInfo.name ? `${pageInfo.name} Instagram` : "Instagram"),
        ig?.username
          ? `@${ig.username.replace(/^@/, "")}`
          : ig?.name || (ig ? "Instagram" : "Pending instagram_basic"),
        pageInfo.id,
        encrypted,
        igWarning,
        userId
      )
      .run();
  }

  try {
    await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(pageInfo.id)}/subscribed_apps?subscribed_fields=messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${pageAccessToken}` },
        signal: AbortSignal.timeout(10000),
      }
    );
  } catch {
    // Non-fatal if pages_manage_metadata is absent
  }

  return {
    facebookPage: { id: pageInfo.id, name: pageInfo.name || "Facebook Page" },
    instagramAccount: ig
      ? { id: ig.id, username: ig.username || ig.name || "Instagram" }
      : null,
    availablePages: pages.map((p) => ({ id: p.id, name: p.name || p.id })),
    missingPermissions: [...new Set([...missingFbPerms, ...missingIgPerms])],
  };
}

export async function ensureMetaSystemConnection(userId = "system") {
  const sysToken = getConfiguredMetaSystemToken();
  if (!sysToken) return null;
  return connectMetaToken(sysToken, userId, process.env.META_PAGE_ID);
}

function isMetaSystemNotice(text: string) {
  const clean = text.trim();
  return (
    /^Facebook created this chat because /i.test(clean) ||
    /^Facebook ने यह चैट इसलिए बनाई है क्योंकि /i.test(clean) ||
    /^Auto-label added:/i.test(clean) ||
    /replied to a post\.\s*See post\(/i.test(clean) ||
    /^You are responding to a user comment to a post on your Page/i.test(clean) ||
    /^Lead stage set to /i.test(clean)
  );
}

function shouldFallbackToSingleInstagramThread(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    err.message.includes("Standard Access") ||
    err.message.includes("timed out") ||
    err.message.includes("aborted due to timeout") ||
    err.message.includes("reduce the amount of data")
  );
}

async function fetchConversationMessages(
  convId: string,
  accessToken: string,
  base: string,
  cutoffMs: number
): Promise<GraphMessageItem[]> {
  const collected: GraphMessageItem[] = [];
  let nextUrl: string | undefined =
    `${base}/${encodeURIComponent(convId)}/messages?limit=50&fields=id,created_time,from,to,message,attachments`;

  for (let page = 0; page < 5 && nextUrl; page++) {
    const res: {
      data?: GraphMessageItem[];
      paging?: { next?: string };
    } = await graphGetUrl(nextUrl, accessToken, 25000);
    const items = res.data || [];
    if (!items.length) break;

    let hitOlderThanCutoff = false;
    for (const item of items) {
      const ts = item.created_time ? Date.parse(item.created_time) : 0;
      if (ts && ts < cutoffMs) {
        hitOlderThanCutoff = true;
        continue;
      }
      collected.push(item);
    }

    if (hitOlderThanCutoff) break;
    nextUrl = res.paging?.next;
  }

  return collected;
}

async function fetchConversationsWindow(
  channel: "facebook" | "instagram",
  pageId: string,
  accessToken: string,
  isIgLogin: boolean,
  cutoffMs: number
): Promise<{ conversations: GraphConversation[]; partialNotice: string }> {
  const platform = channel === "instagram" ? "instagram" : "messenger";
  const base = isIgLogin ? IG_GRAPH_BASE : GRAPH_BASE;
  const listBasePath = isIgLogin
    ? `/me/conversations?platform=instagram`
    : `/${encodeURIComponent(pageId)}/conversations?platform=${platform}`;

  const collected: GraphConversation[] = [];
  const seenIds = new Set<string>();
  let partialNotice = "";

  // First try standard batch pagination (25 for FB, 15 for IG) across the 30-day window
  const batchLimit = channel === "instagram" ? 15 : 25;
  let nextUrl: string | undefined =
    `${base}${listBasePath}&limit=${batchLimit}&fields=id,updated_time,participants`;

  try {
    for (let page = 0; page < 25 && nextUrl; page++) {
      const res: {
        data?: GraphConversation[];
        paging?: { next?: string };
      } = await graphGetUrl(nextUrl, accessToken, 25000);
      const rows = res.data || [];
      if (!rows.length) break;

      let reachedOlder = false;
      for (const conv of rows) {
        if (!conv.id || seenIds.has(conv.id)) continue;
        const ts = conv.updated_time ? Date.parse(conv.updated_time) : 0;
        if (ts && ts < cutoffMs) {
          reachedOlder = true;
          continue;
        }
        seenIds.add(conv.id);
        collected.push(conv);
      }

      if (reachedOlder) break;
      nextUrl = res.paging?.next;
    }
  } catch (err) {
    // Instagram Development Mode / Standard Access times out on batch queries (>1 thread) when
    // scanning non-tester customer threads. Fall back to limit=1 pagination so accessible threads
    // (such as App Testers / recent threads) are still synced cleanly.
    if (channel === "instagram" && shouldFallbackToSingleInstagramThread(err)) {
      let singleUrl: string | undefined =
        `${base}${listBasePath}&limit=1&fields=id,updated_time`;
      for (let i = 0; i < 15 && singleUrl; i++) {
        try {
          const singleRes: {
            data?: GraphConversation[];
            paging?: { next?: string };
          } = await graphGetUrl(singleUrl, accessToken, 20000);
          const rows = singleRes.data || [];
          if (!rows.length) break;

          let reachedOlder = false;
          for (const conv of rows) {
            if (!conv.id || seenIds.has(conv.id)) continue;
            const ts = conv.updated_time ? Date.parse(conv.updated_time) : 0;
            if (ts && ts < cutoffMs) {
              reachedOlder = true;
              continue;
            }
            try {
              const detail = await graphGet<GraphConversation>(
                `/${encodeURIComponent(conv.id)}?fields=id,updated_time,participants`,
                accessToken,
                base,
                20000
              );
              seenIds.add(conv.id);
              collected.push({ ...conv, ...detail });
            } catch {
              seenIds.add(conv.id);
              collected.push(conv);
            }
          }
          if (reachedOlder) break;
          singleUrl = singleRes.paging?.next;
        } catch (stepErr) {
          if (shouldFallbackToSingleInstagramThread(stepErr)) {
            partialNotice =
              collected.length > 0
                ? `Synced ${collected.length} accessible IG thread(s); Meta Standard Access timed out scanning non-tester threads (enable Live Mode + Advanced Access for instagram_manage_messages to sync all historical IG DMs).`
                : "Instagram inbox scan timed out in Meta Development Mode (Standard Access). Switch Satmi Support to Live Mode with Advanced Access for instagram_manage_messages.";
            break;
          }
          throw stepErr;
        }
      }
    } else {
      throw err;
    }
  }

  // Fetch 30-day messages for each conversation in small parallel batches
  const batchSize = 5;
  for (let i = 0; i < collected.length; i += batchSize) {
    const chunk = collected.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async (conv) => {
        try {
          const msgs = await fetchConversationMessages(conv.id, accessToken, base, cutoffMs);
          conv.messages = { data: msgs };
        } catch {
          conv.messages = { data: [] };
        }
      })
    );
  }

  return { conversations: collected, partialNotice };
}

/**
 * Pulls conversations & messages from the last 30 days on Facebook Messenger and Instagram Direct.
 */
export async function syncMetaInboxes(lookbackDays = SYNC_LOOKBACK_DAYS) {
  const db = await operationsDb();
  await ensureDefaultMailboxRow();

  let accounts = await db
    .prepare("SELECT * FROM support_social_accounts WHERE encrypted_access_token <> ''")
    .all<Record<string, unknown>>();

  if (!accounts.results.length && getConfiguredMetaSystemToken()) {
    await ensureMetaSystemConnection("system").catch(() => null);
    accounts = await db
      .prepare("SELECT * FROM support_social_accounts WHERE encrypted_access_token <> ''")
      .all<Record<string, unknown>>();
  }

  const cutoffMs = Date.now() - Math.max(1, lookbackDays) * 86400_000;
  let imported = 0;
  let threadsSynced = 0;
  const channelResults: Record<string, { threads: number; imported: number; error: string }> = {};

  for (const account of accounts.results) {
    const channel = String(account.channel) as "facebook" | "instagram";
    const pageId = String(account.page_id || account.account_id || "");
    const selfAccountId = String(account.account_id || pageId);
    if (!pageId) continue;

    let channelImported = 0;
    let channelThreads = 0;

    try {
      const accessToken = decryptToken(String(account.encrypted_access_token));
      const isIgLogin = channel === "instagram" && pageId === "ig_login";

      const { conversations, partialNotice } = await fetchConversationsWindow(
        channel,
        pageId,
        accessToken,
        isIgLogin,
        cutoffMs
      );

      for (const conv of conversations) {
        const messages = [...(conv.messages?.data || [])].reverse();
        if (!messages.length) continue;

        const nonEmptyMsgs = messages.filter(
          (m) => Boolean(m.message?.trim()) || Boolean(m.attachments?.data?.length)
        );
        if (
          nonEmptyMsgs.length === 1 &&
          !nonEmptyMsgs[0].attachments?.data?.length &&
          String(nonEmptyMsgs[0].message || "").trim() === "."
        ) {
          continue;
        }

        const participants = conv.participants?.data || [];
        const customerParticipant =
          participants.find((p) => p.id !== pageId && p.id !== selfAccountId) ||
          messages.find((m) => m.from?.id && m.from.id !== pageId && m.from.id !== selfAccountId)
            ?.from;

        const externalUserId = String(customerParticipant?.id || conv.id);
        const customerUsername = customerParticipant?.username
          ? `@${customerParticipant.username.replace(/^@/, "")}`
          : "";
        const customerName =
          customerParticipant?.name ||
          customerUsername ||
          `${channel === "instagram" ? "Instagram" : "Facebook"} User`;
        const customerIdentifier =
          customerUsername ||
          customerParticipant?.email ||
          `${channel}:${externalUserId}`;

        const isCustomerMsg = (m: GraphMessageItem) =>
          m.from?.id !== pageId && m.from?.id !== selfAccountId && Boolean(m.message?.trim());
        const realCustomerMsg = messages.find(
          (m) => isCustomerMsg(m) && !isMetaSystemNotice(String(m.message || ""))
        );
        const rawFirst = String(realCustomerMsg?.message || "").replace(/\s+/g, " ").trim();
        const firstSnippet = rawFirst ? rawFirst.slice(0, 72) : "";
        const subject =
          firstSnippet ||
          `${channel === "instagram" ? "Instagram DM" : "Facebook Message"} from ${customerName}`;

        const threadKey = `${channel === "instagram" ? "ig" : "fb"}:${conv.id}`;
        const latestConvTs = conv.updated_time
          ? new Date(conv.updated_time).toISOString()
          : new Date().toISOString();

        await db.transaction(async (sql) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${threadKey}))`;
          const [existing] = await sql`
            SELECT id, status FROM support_tickets
            WHERE mailbox = ${mailbox()} AND gmail_thread_id = ${threadKey}
            FOR UPDATE
          `;

          const ticketId = existing ? String(existing.id) : randomUUID();

          if (!existing) {
            const slaDue = computeSlaDueAt(latestConvTs, "normal");
            await sql`
              INSERT INTO support_tickets (
                id, mailbox, gmail_thread_id, subject, customer_email, customer_name,
                channel, external_user_id, external_username, status, updated_at, last_inbound_at, sla_due_at
              ) VALUES (
                ${ticketId}, ${mailbox()}, ${threadKey}, ${subject}, ${customerIdentifier}, ${customerName},
                ${channel}, ${externalUserId}, ${customerUsername || customerName}, 'open', ${latestConvTs}::timestamptz, ${latestConvTs}::timestamptz, ${slaDue}::timestamptz
              )
            `;
          }

          let hasNewInbound = false;
          let latestInboundIso = "";
          let earliestOutboundIso = "";
          for (const msg of messages) {
            const msgKey = `${channel}:${msg.id}`;
            const [already] = await sql`
              SELECT id FROM support_messages WHERE gmail_message_id = ${msgKey}
            `;
            if (already) continue;

            const isOutbound =
              msg.from?.id === pageId || msg.from?.id === selfAccountId;
            const direction = isOutbound ? "outbound" : "inbound";
            const createdAt = msg.created_time
              ? new Date(msg.created_time).toISOString()
              : new Date().toISOString();
            if (!isOutbound) {
              hasNewInbound = true;
              if (!latestInboundIso || createdAt > latestInboundIso) latestInboundIso = createdAt;
            } else if (!earliestOutboundIso || createdAt < earliestOutboundIso) {
              earliestOutboundIso = createdAt;
            }

            const msgAttachments = (msg.attachments?.data || [])
              .map((a, idx) => {
                const url = a.file_url || a.image_data?.url || "";
                const mimeType =
                  a.mime_type ||
                  (a.image_data?.url ? "image/jpeg" : "");
                const name =
                  a.name ||
                  (mimeType.startsWith("image/") ? `image-${idx + 1}.jpg` : `attachment-${idx + 1}`);
                return {
                  attachmentId: a.id || `${msg.id}-${idx}`,
                  name,
                  mimeType,
                  ...(url ? { url } : {}),
                };
              })
              .filter((a) => Boolean(a.url || a.attachmentId));

            const bodyText =
              msg.message?.trim() ||
              (msgAttachments.length
                ? ""
                : "(Media message)");

            await sql`
              INSERT INTO support_messages (
                id, ticket_id, gmail_message_id, message_id, direction, sender, recipients,
                body, attachments, delivery_status, inbound_auth_verified, created_at
              ) VALUES (
                ${randomUUID()}, ${ticketId}, ${msgKey}, ${msg.id}, ${direction},
                ${isOutbound ? String(account.account_name || channel) : customerName},
                ${isOutbound ? customerIdentifier : String(account.account_name || channel)},
                ${bodyText},
                ${sql.json(msgAttachments)},
                ${isOutbound ? "sent" : "received"},
                ${!isOutbound},
                ${createdAt}
              )
            `;
            channelImported++;
            imported++;
          }

          if (earliestOutboundIso) {
            await sql`
              UPDATE support_tickets
              SET first_response_at = COALESCE(first_response_at, ${earliestOutboundIso}::timestamptz)
              WHERE id = ${ticketId}
            `;
          }

          if (existing && hasNewInbound) {
            const inboundTs = latestInboundIso || latestConvTs;
            await sql`
              UPDATE support_tickets
              SET status = CASE WHEN status IN ('waiting', 'resolved') THEN 'open' ELSE status END,
                  resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
                  external_user_id = ${externalUserId},
                  external_username = ${customerUsername || customerName},
                  last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${inboundTs}::timestamptz), ${inboundTs}::timestamptz),
                  updated_at = GREATEST(updated_at, ${latestConvTs}::timestamptz),
                  version = version + 1
              WHERE id = ${ticketId}
            `;
          }

          await assignWaitingTickets(sql);
        });
        channelThreads++;
        threadsSynced++;
      }

      await db
        .prepare(
          "UPDATE support_social_accounts SET last_sync_at = NOW(), last_error = ? WHERE channel = ?"
        )
        .bind(partialNotice, channel)
        .run();

      channelResults[channel] = {
        threads: channelThreads,
        imported: channelImported,
        error: partialNotice,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Sync failed";
      await db
        .prepare("UPDATE support_social_accounts SET last_error = ? WHERE channel = ?")
        .bind(errMsg, channel)
        .run();
      channelResults[channel] = {
        threads: channelThreads,
        imported: channelImported,
        error: errMsg,
      };
    }
  }

  return { ok: true, imported, threadsSynced, channels: channelResults };
}

async function postMetaMessage(
  endpoint: string,
  accessToken: string,
  payload: Record<string, unknown>
): Promise<{ message_id?: string; error?: { message?: string; code?: number; error_subcode?: number } }> {
  const res = await fetch(stripAccessTokenFromUrl(endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    message_id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!res.ok || data.error) {
    const err = new Error(
      redactMetaError(data.error?.message || `Meta Send API failed (${res.status})`)
    ) as Error & {
      code?: number;
      subcode?: number;
      isNetworkUncertain?: boolean;
    };
    err.code = data.error?.code;
    err.subcode = data.error?.error_subcode;
    err.isNetworkUncertain = false;
    throw err;
  }
  return data;
}

type OutboundMetaAttachment = {
  attachmentId?: string;
  name: string;
  mimeType?: string;
  dataBase64?: string;
};

async function postMetaAttachment(
  endpoint: string,
  accessToken: string,
  recipientId: string,
  att: OutboundMetaAttachment,
  extraFields: Record<string, string> = {}
): Promise<{ message_id?: string }> {
  const mime = String(att.mimeType || "application/octet-stream");
  const metaType = mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : "file";

  const form = new FormData();
  form.set("recipient", JSON.stringify({ id: recipientId }));
  form.set(
    "message",
    JSON.stringify({
      attachment: { type: metaType, payload: { is_reusable: false } },
    })
  );
  for (const [k, v] of Object.entries(extraFields)) {
    form.set(k, v);
  }
  const bytes = Buffer.from(String(att.dataBase64 || ""), "base64");
  form.set("filedata", new Blob([bytes], { type: mime }), att.name || "attachment");

  const res = await fetch(stripAccessTokenFromUrl(endpoint), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    message_id?: string;
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!res.ok || data.error) {
    const err = new Error(
      redactMetaError(data.error?.message || `Meta attachment send failed (${res.status})`)
    ) as Error & {
      code?: number;
      subcode?: number;
      isNetworkUncertain?: boolean;
    };
    err.code = data.error?.code;
    err.subcode = data.error?.error_subcode;
    err.isNetworkUncertain = false;
    throw err;
  }
  return data;
}

type MetaDeliveryState = {
  textSent?: boolean;
  sentAttachmentIds?: string[];
  lastMessageId?: string;
};

function parseMetaDeliveryState(raw: unknown): MetaDeliveryState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  return {
    textSent: Boolean(obj.textSent),
    sentAttachmentIds: Array.isArray(obj.sentAttachmentIds)
      ? obj.sentAttachmentIds.map(String)
      : [],
    lastMessageId: typeof obj.lastMessageId === "string" ? obj.lastMessageId : undefined,
  };
}

/**
 * Flushes outbound Instagram and Facebook replies from support_messages to the actual Meta inbox.
 * Uses atomic row claiming (`FOR UPDATE OF m SKIP LOCKED`) and tracks partial text/attachment delivery
 * so retries never duplicate already-sent text or attachments.
 */
export async function flushMetaOutbox() {
  const db = await operationsDb();

  // Reclaim stale 'sending' rows (> 5 min) as 'uncertain' so operators verify before retrying
  await db
    .prepare(
      `UPDATE support_messages
       SET delivery_status = 'uncertain',
           last_error = 'Send interrupted or timed out; verify in Meta Business Suite before retrying'
       WHERE direction = 'outbound'
         AND delivery_status = 'sending'
         AND COALESCE(send_started_at, created_at) < now() - interval '5 minutes'
         AND ticket_id IN (SELECT id FROM support_tickets WHERE channel IN ('instagram', 'facebook'))`
    )
    .run();

  const socialRows = await db
    .prepare("SELECT * FROM support_social_accounts")
    .all<Record<string, unknown>>();
  const accountByChannel = new Map(
    socialRows.results.map((r) => [String(r.channel), r])
  );

  let sentCount = 0;

  for (let i = 0; i < 20; i++) {
    const m = await db.transaction(async (sql) => {
      const [r] = await sql`
        SELECT m.*, t.channel, t.external_user_id, t.external_username, t.customer_email
        FROM support_messages m
        JOIN support_tickets t ON t.id = m.ticket_id
        WHERE m.direction = 'outbound'
          AND t.channel IN ('instagram', 'facebook')
          AND m.delivery_status = 'queued'
          AND m.attempts < 5
        ORDER BY m.created_at
        FOR UPDATE OF m SKIP LOCKED
        LIMIT 1
      `;
      if (!r) return null;
      await sql`
        UPDATE support_messages
        SET delivery_status = 'sending',
            send_started_at = now(),
            attempts = attempts + 1
        WHERE id = ${r.id}
      `;
      return r;
    });
    if (!m) break;

    if (String(m.created_by || "") === "ai_agent") {
      const gate = await checkAiLiveOutboundGate({
        channel: String(m.channel || ""),
        customerEmail: String(m.customer_email || ""),
        externalUsername: String(m.external_username || ""),
        externalUserId: String(m.external_user_id || ""),
      });
      if (!gate.allowed) {
        await db
          .prepare(
            "UPDATE support_messages SET delivery_status = 'ai_draft', send_started_at = NULL, last_error = ? WHERE id = ?"
          )
          .bind(gate.reason, m.id)
          .run();
        continue;
      }
    }

    const channel = String(m.channel) as "instagram" | "facebook";
    const account = accountByChannel.get(channel);
    const recipientId = String(m.external_user_id || "");
    const deliveryState = parseMetaDeliveryState(m.meta_delivery_state);
    const sentAttSet = new Set(deliveryState.sentAttachmentIds || []);

    const persistPartialState = async () => {
      await db
        .prepare("UPDATE support_messages SET meta_delivery_state = ?::jsonb WHERE id = ?")
        .bind(
          JSON.stringify({
            textSent: Boolean(deliveryState.textSent),
            sentAttachmentIds: [...sentAttSet],
            ...(deliveryState.lastMessageId ? { lastMessageId: deliveryState.lastMessageId } : {}),
          }),
          m.id
        )
        .run()
        .catch(() => null);
    };

    try {
      if (!account || !String(account.encrypted_access_token || "")) {
        throw Object.assign(
          new Error(
            `${channel === "instagram" ? "Instagram" : "Facebook"} inbox is not connected in Mailbox & team settings`
          ),
          { isNetworkUncertain: false }
        );
      }
      if (!recipientId) {
        throw Object.assign(new Error(`Missing recipient ID for ${channel} conversation`), {
          isNetworkUncertain: false,
        });
      }

      const accessToken = decryptToken(String(account.encrypted_access_token));
      const pageId = String(account.page_id || account.account_id || "me");
      const accountId = String(account.account_id || "");
      const isIgLogin = channel === "instagram" && pageId === "ig_login";
      const messageText = String(m.body || "").trim();
      const attachments = (Array.isArray(m.attachments) ? m.attachments : []).filter(
        (a): a is OutboundMetaAttachment =>
          Boolean(a && typeof a === "object" && "dataBase64" in a && a.dataBase64)
      );

      let payloadResult: { message_id?: string } = {
        ...(deliveryState.lastMessageId ? { message_id: deliveryState.lastMessageId } : {}),
      };

      if (channel === "instagram") {
        const primaryEndpoint = isIgLogin
          ? `${IG_GRAPH_BASE}/me/messages`
          : `${GRAPH_BASE}/${encodeURIComponent(pageId)}/messages`;
        const fallbackEndpoint =
          !isIgLogin && accountId && accountId !== pageId
            ? `${GRAPH_BASE}/${encodeURIComponent(accountId)}/messages`
            : "";

        let activeEndpoint = primaryEndpoint;
        if (messageText && !deliveryState.textSent) {
          try {
            payloadResult = await postMetaMessage(activeEndpoint, accessToken, {
              recipient: { id: recipientId },
              message: { text: messageText },
            });
          } catch (igErr) {
            if (fallbackEndpoint) {
              activeEndpoint = fallbackEndpoint;
              payloadResult = await postMetaMessage(activeEndpoint, accessToken, {
                recipient: { id: recipientId },
                message: { text: messageText },
              });
            } else {
              throw igErr;
            }
          }
          deliveryState.textSent = true;
          if (payloadResult.message_id) deliveryState.lastMessageId = payloadResult.message_id;
          await persistPartialState();
        }
        for (let idx = 0; idx < attachments.length; idx++) {
          const att = attachments[idx];
          const attKey = String(att.attachmentId || `${att.name}:${idx}`);
          if (sentAttSet.has(attKey)) continue;
          try {
            payloadResult = await postMetaAttachment(activeEndpoint, accessToken, recipientId, att);
          } catch (attErr) {
            if (fallbackEndpoint && activeEndpoint !== fallbackEndpoint) {
              activeEndpoint = fallbackEndpoint;
              payloadResult = await postMetaAttachment(activeEndpoint, accessToken, recipientId, att);
            } else {
              throw attErr;
            }
          }
          sentAttSet.add(attKey);
          if (payloadResult.message_id) deliveryState.lastMessageId = payloadResult.message_id;
          await persistPartialState();
        }
      } else {
        const fbEndpoint = `${GRAPH_BASE}/${encodeURIComponent(pageId)}/messages`;
        let useHumanTag = false;
        if (messageText && !deliveryState.textSent) {
          try {
            payloadResult = await postMetaMessage(fbEndpoint, accessToken, {
              recipient: { id: recipientId },
              messaging_type: "RESPONSE",
              message: { text: messageText },
            });
          } catch (fbErr) {
            const metaErr = fbErr as Error & { code?: number; subcode?: number };
            const isOutside24h =
              metaErr.code === 10 ||
              metaErr.subcode === 2018278 ||
              /outside.*window|24.?hour/i.test(metaErr.message || "");
            if (isOutside24h) {
              useHumanTag = true;
              try {
                payloadResult = await postMetaMessage(fbEndpoint, accessToken, {
                  recipient: { id: recipientId },
                  messaging_type: "MESSAGE_TAG",
                  tag: "HUMAN_AGENT",
                  message: { text: messageText },
                });
              } catch (tagErr) {
                const tagMsg = tagErr instanceof Error ? tagErr.message : String(tagErr);
                if (/HUMAN_AGENT|prior approval/i.test(tagMsg)) {
                  throw Object.assign(
                    new Error(
                      "Meta 24-hour reply window expired for this conversation, and this Meta app does not have HUMAN_AGENT tag approval yet. Reply from Meta Business Suite or request Human Agent permission in Meta App Review."
                    ),
                    { isNetworkUncertain: false }
                  );
                }
                throw tagErr;
              }
            } else {
              throw fbErr;
            }
          }
          deliveryState.textSent = true;
          if (payloadResult.message_id) deliveryState.lastMessageId = payloadResult.message_id;
          await persistPartialState();
        }
        for (let idx = 0; idx < attachments.length; idx++) {
          const att = attachments[idx];
          const attKey = String(att.attachmentId || `${att.name}:${idx}`);
          if (sentAttSet.has(attKey)) continue;
          try {
            payloadResult = await postMetaAttachment(
              fbEndpoint,
              accessToken,
              recipientId,
              att,
              useHumanTag
                ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
                : { messaging_type: "RESPONSE" }
            );
          } catch (attErr) {
            const metaErr = attErr as Error & { code?: number; subcode?: number };
            const isOutside24h =
              !useHumanTag &&
              (metaErr.code === 10 ||
                metaErr.subcode === 2018278 ||
                /outside.*window|24.?hour/i.test(metaErr.message || ""));
            if (isOutside24h) {
              useHumanTag = true;
              try {
                payloadResult = await postMetaAttachment(
                  fbEndpoint,
                  accessToken,
                  recipientId,
                  att,
                  { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
                );
              } catch (tagErr) {
                const tagMsg = tagErr instanceof Error ? tagErr.message : String(tagErr);
                if (/HUMAN_AGENT|prior approval/i.test(tagMsg)) {
                  throw Object.assign(
                    new Error(
                      "Meta 24-hour reply window expired for this conversation, and this Meta app does not have HUMAN_AGENT tag approval yet. Reply from Meta Business Suite or request Human Agent permission in Meta App Review."
                    ),
                    { isNetworkUncertain: false }
                  );
                }
                throw tagErr;
              }
            } else {
              throw attErr;
            }
          }
          sentAttSet.add(attKey);
          if (payloadResult.message_id) deliveryState.lastMessageId = payloadResult.message_id;
          await persistPartialState();
        }
      }

      const externalMsgId = payloadResult.message_id || deliveryState.lastMessageId || `meta_${randomUUID()}`;
      const messageRowId = String(m.id);
      const ticketRowId = String(m.ticket_id);

      await db.transaction(async (sql) => {
        await sql`
          UPDATE support_messages
          SET delivery_status = 'sent',
              gmail_message_id = ${`${channel}:${externalMsgId}`},
              message_id = ${externalMsgId},
              last_error = '',
              send_started_at = NULL
          WHERE id = ${messageRowId}
        `;
        await sql`
          UPDATE support_tickets
          SET status = ${m.resolve_after_send ? "resolved" : "waiting"},
              first_response_at = COALESCE(first_response_at, NOW()),
              resolved_at = CASE WHEN ${Boolean(m.resolve_after_send)} THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END,
              updated_at = NOW(),
              version = version + 1
          WHERE id = ${ticketRowId}
        `;
        await supportEvent(
          sql,
          String(m.created_by || "system"),
          ticketRowId,
          "outbound_sent",
          { id: messageRowId, channel }
        );
      });
      sentCount++;
    } catch (e) {
      const errObj = e as Error & { isNetworkUncertain?: boolean };
      const isUncertain =
        errObj.isNetworkUncertain !== false &&
        (errObj.name === "TimeoutError" || errObj.name === "AbortError" || !("code" in errObj));
      const errText = redactMetaError(e instanceof Error ? e.message : "Send failed");
      await db
        .prepare(
          "UPDATE support_messages SET delivery_status = ?, send_started_at = NULL, last_error = ? WHERE id = ?"
        )
        .bind(
          isUncertain ? "uncertain" : "failed",
          isUncertain
            ? `Delivery uncertain (${errText}). Check Meta Business Suite before retrying.`
            : errText,
          m.id
        )
        .run();
    }
  }

  return { sent: sentCount };
}

export function verifyMetaSignature(rawBody: string, signatureHeader: string | null) {
  const secret = (process.env.META_APP_SECRET || "").trim();
  if (!secret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ingests real-time webhook events from Meta Messenger & Instagram Direct.
 */
export async function ingestMetaWebhook(payload: {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        attachments?: Array<{ type?: string; payload?: { url?: string } }>;
      };
    }>;
  }>;
}) {
  const channel: "instagram" | "facebook" | null =
    payload.object === "instagram"
      ? "instagram"
      : payload.object === "page"
        ? "facebook"
        : null;
  if (!channel) return { processed: 0, ticketIds: [] as string[] };

  const db = await operationsDb();
  await ensureDefaultMailboxRow();
  let processed = 0;
  const ticketIds: string[] = [];

  const socialRow = await db
    .prepare("SELECT encrypted_access_token FROM support_social_accounts WHERE channel = ?")
    .bind(channel)
    .first<{ encrypted_access_token?: string }>();
  const channelToken = socialRow?.encrypted_access_token
    ? (() => {
        try {
          return decryptToken(String(socialRow.encrypted_access_token));
        } catch {
          return "";
        }
      })()
    : "";

  for (const entry of payload.entry || []) {
    const pageOrIgId = String(entry.id || "");
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg?.mid || msg.is_echo) continue;
      const senderId = String(ev.sender?.id || "");
      if (!senderId || senderId === pageOrIgId) continue;

      const webhookAttachments = (msg.attachments || [])
        .map((a, idx) => {
          const url = a.payload?.url || "";
          const kind = String(a.type || "").toLowerCase();
          const mimeType =
            kind === "image"
              ? "image/jpeg"
              : kind === "video"
                ? "video/mp4"
                : kind === "audio"
                  ? "audio/mpeg"
                  : "";
          const name =
            kind === "image"
              ? `image-${idx + 1}.jpg`
              : kind === "video"
                ? `video-${idx + 1}.mp4`
                : kind === "audio"
                  ? `audio-${idx + 1}.mp3`
                  : `attachment-${idx + 1}`;
          return {
            attachmentId: `${String(msg.mid)}-${idx}`,
            name,
            mimeType,
            ...(url ? { url } : {}),
          };
        })
        .filter((a) => Boolean(a.url));

      const text =
        msg.text?.trim() ||
        (webhookAttachments.length
          ? ""
          : "(Media message)");

      let customerName = `${channel === "instagram" ? "@ig_" : "fb_"}${senderId.slice(-6)}`;
      let customerHandle = customerName;
      if (channelToken) {
        try {
          const profile = await graphGet<{
            name?: string;
            username?: string;
            first_name?: string;
            last_name?: string;
          }>(
            channel === "instagram"
              ? `/${encodeURIComponent(senderId)}?fields=name,username`
              : `/${encodeURIComponent(senderId)}?fields=first_name,last_name,name`,
            channelToken
          );
          const resolvedName =
            profile.name ||
            [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
          const resolvedUser = profile.username
            ? `@${profile.username.replace(/^@/, "")}`
            : "";
          if (resolvedName) customerName = resolvedName;
          if (resolvedUser) customerHandle = resolvedUser;
          else if (resolvedName) customerHandle = resolvedName;
        } catch {
          // Keep fallback label if profile lookup isn't permitted
        }
      }

      const mid = String(msg.mid);
      const createdAt = ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString();
      const threadKey = `${channel === "instagram" ? "ig_dm" : "fb_dm"}:${senderId}`;
      const msgKey = `${channel}:${mid}`;
      const cleanSubject =
        (!isMetaSystemNotice(text) ? text.replace(/\s+/g, " ").trim().slice(0, 72) : "") ||
        `${channel === "instagram" ? "Instagram DM" : "Facebook Message"} from ${customerName}`;

      await db.transaction(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${threadKey}))`;
        const [dup] = await sql`
          SELECT id FROM support_messages WHERE gmail_message_id = ${msgKey}
        `;
        if (dup) return;

        const [existing] = await sql`
          SELECT id FROM support_tickets
          WHERE (mailbox = ${mailbox()} AND gmail_thread_id = ${threadKey})
             OR (channel = ${channel} AND external_user_id = ${senderId} AND status <> 'resolved')
          ORDER BY updated_at DESC
          LIMIT 1
          FOR UPDATE
        `;

        const ticketId = existing ? String(existing.id) : randomUUID();

        if (!existing) {
          const slaDue = computeSlaDueAt(createdAt, "normal");
          await sql`
            INSERT INTO support_tickets (
              id, mailbox, gmail_thread_id, subject, customer_email, customer_name,
              channel, external_user_id, external_username, status, updated_at, last_inbound_at, sla_due_at
            ) VALUES (
              ${ticketId}, ${mailbox()}, ${threadKey}, ${cleanSubject},
              ${customerHandle}, ${customerName}, ${channel}, ${senderId}, ${customerHandle},
              'open', NOW(), ${createdAt}::timestamptz, ${slaDue}::timestamptz
            )
          `;
        } else {
          await sql`
            UPDATE support_tickets
            SET status = CASE WHEN status IN ('waiting', 'resolved') THEN 'open' ELSE status END,
                resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
                customer_name = ${customerName},
                customer_email = ${customerHandle},
                external_username = ${customerHandle},
                last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${createdAt}::timestamptz), ${createdAt}::timestamptz),
                updated_at = NOW(),
                version = version + 1
            WHERE id = ${ticketId}
          `;
        }

        await sql`
          INSERT INTO support_messages (
            id, ticket_id, gmail_message_id, message_id, direction, sender, recipients,
            body, attachments, delivery_status, inbound_auth_verified, created_at
          ) VALUES (
            ${randomUUID()}, ${ticketId}, ${msgKey}, ${mid}, 'inbound',
            ${customerName}, ${channel}, ${text}, ${sql.json(webhookAttachments)}, 'received', TRUE,
            ${createdAt}
          )
        `;

        await assignWaitingTickets(sql);
        ticketIds.push(ticketId);
        processed++;
      });
    }
  }

  return { processed, ticketIds };
}
