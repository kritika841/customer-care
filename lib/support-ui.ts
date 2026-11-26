import { visibleEmailBody } from "./email-body";
import { computeCustomer360 } from "./operations/sla";
import type { supportData } from "./operations/support";

export type Data = Awaited<ReturnType<typeof supportData>>;

export type MessageAttachment = {
  name: string;
  attachmentId: string;
  mimeType?: string;
  size?: number;
  url?: string;
};

export type MessageTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  model: string;
  operationType: string;
};

export type Message = {
  id: string;
  ticket_id?: string;
  direction: string;
  body: string;
  sender: string;
  created_at: string;
  delivery_status: string;
  last_error: string;
  attachments: MessageAttachment[];
  token_usage?: MessageTokenUsage | null;
};

export type Event = {
  id: string;
  action: string;
  created_at: string;
  actor_id: string;
  details: unknown;
};

export type ReplyTemplate = {
  id: string;
  name: string;
  body: string;
  macro_status?: string;
  macro_priority?: string;
  macro_tags?: string[];
  shortcut?: string;
  updated_at: string;
};

export type ActiveMacro = {
  templateName: string;
  macroStatus: string;
  macroPriority: string;
  macroTags: string[];
};

export type ActivityLog = {
  id: number;
  source: string;
  eventType: string;
  level: string;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
  actorName?: string;
  actorRole?: string;
};

export type PendingAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
};

export type CustomerInfo = {
  name: string;
  email: string;
  phone: string;
  city?: string;
  state?: string;
  tags: string[];
};

export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;

export function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function getColumnSnapshot() {
  const w = window.innerWidth;
  if (w < 640) return 1;
  if (w < 1024) return 2;
  if (w < 1400) return 3;
  return 4;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageAttachment(att: { name?: string; mimeType?: string; url?: string }) {
  const mime = String(att.mimeType || "").toLowerCase();
  if (mime.startsWith("image/") && !mime.includes("svg")) return true;
  const target = `${att.name || ""} ${att.url || ""}`.toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|avif)(?:$|[?#])/i.test(target);
}

export function isPdfAttachment(att: { name?: string; mimeType?: string }) {
  const mime = String(att.mimeType || "").toLowerCase();
  if (mime === "application/pdf") return true;
  return /\.pdf(?:$|[?#])/i.test(String(att.name || ""));
}

export function cleanTicketPreviewText(raw: string, fallback = ""): string {
  const base = visibleEmailBody(String(raw || ""))
    .replace(/\[Attachment:\s*[^\]]+\]/gi, "[Attachment]")
    .replace(/\{External\}[^\n]*(?:outside\s+[^\n]+)?/gi, "")
    .replace(/https?:\/\/scontent[^\s]+/gi, "[Media]")
    .replace(/https?:\/\/[^\s]{60,}/g, "[Link]")
    .replace(/^[-_=]{4,}$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || fallback;
}

export function extractLegacyAttachmentUrls(body: string): {
  cleanBody: string;
  urls: string[];
} {
  const urls: string[] = [];
  const cleanBody = body
    .replace(/\[Attachment:\s*([^\]]+)\]/gi, (_match, inner: string) => {
      const parts = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s));
      urls.push(...parts);
      return parts.length ? "" : _match;
    })
    .trim();
  return { cleanBody, urls };
}

export async function fileToBase64Attachment(file: File): Promise<PendingAttachment> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return {
    name: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    dataBase64: btoa(binary),
  };
}

export function packMasonryColumns<T extends { subject?: string | null; excerpt?: string | null }>(
  items: T[],
  columnCount: number,
): T[][] {
  const count = Math.max(1, columnCount);
  const cols: T[][] = Array.from({ length: count }, () => []);
  const heights = new Array<number>(count).fill(0);

  for (const item of items) {
    let shortestIdx = 0;
    for (let i = 1; i < count; i++) {
      if (heights[i] < heights[shortestIdx]) shortestIdx = i;
    }
    cols[shortestIdx].push(item);
    const subjectLen = String(item.subject || "").length;
    const excerptLen = visibleEmailBody(String(item.excerpt || "")).trim().length;
    const estimatedLines = Math.min(5, Math.max(1, Math.ceil((excerptLen || 36) / 38)));
    heights[shortestIdx] += 116 + (subjectLen > 42 ? 22 : 0) + estimatedLines * 20;
  }

  return cols;
}

export const emptySupportSnapshot = {
  tickets: [],
  selectedTicket: null,
  page: 1,
  totalPages: 1,
  total: 0,
  summary: {
    open: 0,
    unassigned: 0,
    escalated: 0,
    resolved: 0,
    email_open: 0,
    instagram_open: 0,
    facebook_open: 0,
    needs_reply: 0,
    sla_breached: 0,
  },
  agents: [],
  availableAgents: 0,
  messages: [],
  events: [],
  orders: [],
  templates: [],
  customer: { name: "", email: "", phone: "", city: "", state: "", tags: [] },
  customer360: computeCustomer360([], 0),
  linkedCustomer: {
    isLinked: false,
    linkedOrderId: null,
    linkedEmail: "",
    linkedPhone: "",
    linkedName: "",
  },
  activeViewers: [],
  connection: { email: "kritika@satmi.in", connected: false },
  socialConnections: [],
  canManage: false,
  userId: "",
  aiEscalations: [],
  aiThreadTokenEstimate: 0,
  aiChatTokenTotals: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    requestCount: 0,
  },
  aiChatTokenLogs: [],
  configured: false,
  pushConfigured: false,
  metaSystemConfigured: false,
  metaPageId: "",
} as unknown as Data;

export const formatShortDate = (s: unknown) =>
  s
    ? new Date(String(s)).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Never";

export function getStatusBadgeStyle(status: string) {
  switch (status) {
    case "open":
      return {
        badge: "bg-success/15 text-success border border-success/25",
        dot: "bg-success",
        label: "Open",
      };
    case "in_progress":
      return {
        badge: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/25",
        dot: "bg-sky-500",
        label: "In progress",
      };
    case "waiting":
      return {
        badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/25",
        dot: "bg-amber-500",
        label: "Waiting",
      };
    case "escalated":
      return {
        badge: "bg-destructive/15 text-destructive border border-destructive/25",
        dot: "bg-destructive",
        label: "Escalated",
      };
    case "resolved":
      return {
        badge: "bg-muted text-muted-foreground border border-border",
        dot: "bg-muted-foreground",
        label: "Resolved",
      };
    default:
      return {
        badge: "bg-muted text-muted-foreground border border-border",
        dot: "bg-muted-foreground",
        label: status.replaceAll("_", " "),
      };
  }
}

export function getPriorityBadgeStyle(priority: string) {
  switch (priority) {
    case "urgent":
      return "bg-destructive/15 text-destructive border border-destructive/25";
    case "high":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/25";
    case "normal":
      return "bg-accent text-accent-foreground border border-border";
    default:
      return "bg-muted text-muted-foreground border border-border";
  }
}

export function getChannelBadge(channel?: string) {
  switch (channel) {
    case "instagram":
      return {
        shortLabel: "Instagram",
        fullLabel: "Instagram Direct",
        className:
          "bg-pink-500/10 text-pink-700 dark:text-pink-400 border border-pink-500/25",
        dotClass: "bg-gradient-to-tr from-amber-500 via-pink-500 to-purple-600",
      };
    case "facebook":
      return {
        shortLabel: "Facebook",
        fullLabel: "Facebook Messenger",
        className:
          "bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/25",
        dotClass: "bg-blue-600 dark:bg-blue-400",
      };
    default:
      return {
        shortLabel: "Email",
        fullLabel: "Email (Gmail)",
        className: "bg-primary/10 text-primary border border-primary/25",
        dotClass: "bg-primary",
      };
  }
}

export function formatTokensCompact(tokens: number): string {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatCostUsd(costUsd: number): string {
  const c = Math.max(0, Number(costUsd) || 0);
  if (c === 0) return "$0.00";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(3)}`;
}

export function formatChatModelLabel(model?: string | null): string {
  const m = String(model || "").trim();
  if (!m) return "AI Agent";
  const lower = m.toLowerCase();
  if (lower.includes("claude-haiku-5-5")) return "Claude Haiku 5.5";
  if (lower.includes("claude-haiku-4-5")) return "Claude Haiku 4.5";
  if (lower.includes("claude-haiku")) return "Claude Haiku";
  if (lower.includes("gemini-2.5-flash")) return "Gemini 2.5 Flash";
  if (lower.includes("gemini-3.5-flash-lite")) return "Gemini 3.5 Flash-Lite";
  if (lower.includes("local")) return "Local Grounded Fallback";
  return m;
}

export function formatCostInr(costUsd: number, usdToInr = 85): string {
  const inr = Math.max(0, Number(costUsd) || 0) * usdToInr;
  if (inr === 0) return "₹0.00";
  if (inr < 0.01) return `₹${inr.toFixed(4)}`;
  if (inr < 1) return `₹${inr.toFixed(2)}`;
  return `₹${inr.toFixed(2)}`;
}
