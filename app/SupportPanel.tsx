"use client";

import { isTransientRequestError, readJson, requestErrorMessage } from "../lib/http";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Mail,
  RefreshCw,
  Send,
  ArrowUpRight,
  ArrowLeft,
  Paperclip,
  CheckCircle2,
  FileText,
  Plus,
  Trash2,
  UserRoundCheck,
  X,
  LayoutGrid,
  Rows3,
  UserCheck,
  Sparkles,
  MessageSquare,
  StickyNote,
  Zap,
  Clock,
  AlertTriangle,
  Download,
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
  Check,
  XCircle,
  Truck,
  Phone,
  Package,
} from "lucide-react";
import SupportSidebar from "../components/SupportSidebar";
import SupportTopBar from "../components/SupportTopBar";
import SupportInsightsView, { type InsightsData } from "../components/SupportInsightsView";
import SupportAiKnowledgeView from "../components/SupportAiKnowledgeView";
import TicketAiAssistantCard, { type AiEscalationItem } from "../components/TicketAiAssistantCard";
import CustomerProfileSidebar from "../components/CustomerProfileSidebar";
import ExcelReviewTable, { type ExcelColumnDef } from "../components/ExcelReviewTable";
import AgentQueueView from "../components/AgentQueueView";
import OrderTrackingModal from "../components/OrderTrackingModal";
import DeclineReplyModal from "../components/DeclineReplyModal";
import SupportErrorBoundary from "../components/SupportErrorBoundary";
import SupportLogsView from "../components/SupportLogsView";
import SupportSettingsView from "../components/SupportSettingsView";
import { SupportModals } from "../components/SupportModals";
import { Button } from "../components/ui/button";
import { useEntryDialog } from "./Modal";
import { visibleEmailBody } from "../lib/email-body";
import { computeCustomer360, evaluateSlaState } from "../lib/operations/sla";
import {
  cleanTicketPreviewText,
  emptySupportSnapshot,
  extractLegacyAttachmentUrls,
  fileToBase64Attachment,
  formatBytes,
  formatShortDate,
  getChannelBadge,
  getColumnSnapshot,
  getPriorityBadgeStyle,
  getStatusBadgeStyle,
  isImageAttachment,
  isPdfAttachment,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  packMasonryColumns,
  subscribeResize,
  type ActiveMacro,
  type ActivityLog,
  type CustomerInfo,
  type Data,
  type Event,
  type Message,
  type PendingAttachment,
  type ReplyTemplate,
} from "../lib/support-ui";

const empty = emptySupportSnapshot;

export default function SupportPanel({
  active,
  isAdmin = false,
  userLabel = "Kritika Singh",
  userEmail = "admin@satmi.in",
  userRole = "admin",
  initialView = "tickets",
  initialQuery = "",
}: {
  active: boolean;
  isAdmin?: boolean;
  userLabel?: string;
  userEmail?: string;
  userRole?: string;
  initialView?: "tickets" | "queue" | "ai" | "insights" | "settings" | "logs";
  initialQuery?: string;
}) {
  const [data, setData] = useState<Data>(empty);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState(initialView === "queue" ? "human_queue" : "all");
  const [channelFilter, setChannelFilter] = useState<"all" | "email" | "instagram" | "facebook">("all");
  const [sortBy] = useState<"newest" | "fifo" | "sla">("newest");
  const [search, setSearch] = useState(initialQuery);
  const [body, setBody] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [notesPanelOpen, setNotesPanelOpen] = useState(true);
  const [detailsSidebarOpen, setDetailsSidebarOpen] = useState(true);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [trackingTarget, setTrackingTarget] = useState<{
    awb?: string;
    orderId?: number | null;
    orderCode?: string;
    ticketId?: string;
    courier?: string;
    trackingUrl?: string;
  } | null>(null);
  const [declineTarget, setDeclineTarget] = useState<{
    id: string;
    ticketNumber: number;
    customerLabel: string;
    customerQuery: string;
    proposedReply: string;
    version?: number;
  } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name: string; downloadUrl: string } | null>(null);
  const [activeMacro, setActiveMacro] = useState<ActiveMacro | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useState<"tickets" | "queue" | "ai" | "insights" | "settings" | "logs">(initialView);
  const [listLayout, setListLayout] = useState<"grid" | "list">("list");
  const [selectedTickets, setSelectedTickets] = useState<string[]>([]);
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<ReplyTemplate | null>(null);
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [requestKey, setRequestKey] = useState("");

  const [newSubject, setNewSubject] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newQuery, setNewQuery] = useState("");
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [insightsDays, setInsightsDays] = useState(14);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [liveViewers, setLiveViewers] = useState<
    Array<{ userId: string; name: string; at: string }>
  >([]);
  const [staleVersion, setStaleVersion] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const streamSignatureRef = useRef("");
  const selectedVersionRef = useRef<{ id: string; version: number | null }>({ id: "", version: null });
  const masonryCols = useSyncExternalStore(subscribeResize, getColumnSnapshot, () => 3);

  useEffect(() => {
    selectedVersionRef.current = {
      id: data.selectedTicket?.id || "",
      version: data.selectedTicket?.version != null ? Number(data.selectedTicket.version) : null,
    };
  }, [data.selectedTicket?.id, data.selectedTicket?.version]);

  const { requestEntry, dialog } = useEntryDialog();
  const [loaded, setLoaded] = useState(false);
  const [deferredSearch, setDeferredSearch] = useState(search);

  useEffect(() => {
    const timer = setTimeout(() => setDeferredSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (quiet && (document.hidden || loadController.current)) return;
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      try {
        const next = await readJson<Data>(
          await fetch(
            "/api/support?" +
              new URLSearchParams({
                ticket: selected,
                page: String(page),
                queue,
                channel: channelFilter,
                sort: sortBy,
                q: deferredSearch,
              }),
            {
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
            }
          )
        );
        if (controller.signal.aborted) return;
        setData(next);
        setLiveViewers(next.activeViewers || []);
        setStaleVersion(false);
        setLoaded(true);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError(requestErrorMessage(e, "Could not load support"));
      } finally {
        if (loadController.current === controller) loadController.current = null;
      }
    },
    [selected, page, queue, channelFilter, sortBy, deferredSearch]
  );

  useEffect(() => {
    if (!active) return;
    const initial = setTimeout(() => void load(), 0);

    const hasSse = typeof EventSource !== "undefined";
    const fallbackTimer = setInterval(() => void load(true), hasSse ? 30000 : 10000);
    let source: EventSource | null = null;
    if (hasSse) {
      source = new EventSource(
        "/api/support/stream?" + new URLSearchParams({ ticket: selected }),
      );
      source.addEventListener("sync", (event) => {
        try {
          const delta = JSON.parse((event as MessageEvent).data) as {
            count?: number;
            maxUpdated?: string;
            selectedVersion?: number | null;
            activeViewers?: Array<{ userId: string; name: string; at: string }>;
          };
          if (Array.isArray(delta.activeViewers)) {
            setLiveViewers(delta.activeViewers);
          }
          const sig = `${delta.count ?? 0}:${delta.maxUpdated ?? ""}`;
          if (streamSignatureRef.current && streamSignatureRef.current !== sig) {
            void load(true);
          }
          streamSignatureRef.current = sig;

          const currentVer =
            selectedVersionRef.current.id === selected ? selectedVersionRef.current.version : null;
          if (
            selected &&
            delta.selectedVersion != null &&
            currentVer != null &&
            delta.selectedVersion !== currentVer
          ) {
            setStaleVersion(true);
          }
        } catch {
          /* ignore malformed SSE frame */
        }
      });
    }

    return () => {
      clearTimeout(initial);
      clearInterval(fallbackTimer);
      source?.close();
      loadController.current?.abort();
      loadController.current = null;
    };
  }, [active, load, selected]);

  // Soft presence heartbeat while viewing a ticket
  useEffect(() => {
    if (!active || !selected) return;
    const ping = (leaving = false) => {
      void fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "viewing", ticketId: selected, leaving }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((res: { activeViewers?: Array<{ userId: string; name: string; at: string }> } | null) => {
          if (res?.activeViewers && !leaving) setLiveViewers(res.activeViewers);
        })
        .catch(() => null);
    };
    const initial = setTimeout(() => ping(false), 300);
    const interval = setInterval(() => ping(false), 15000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      ping(true);
    };
  }, [active, selected]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const response = await fetch("/api/logs", {
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      });
      const payload = (await readJson(response)) as { logs: ActivityLog[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load activity logs");
      setLogs(payload.logs || []);
    } catch (logsError) {
      if (!isTransientRequestError(logsError)) {
        setError(logsError instanceof Error ? logsError.message : "Could not load activity logs");
      }
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const loadInsights = useCallback(async (daysWindow = 14) => {
    setInsightsLoading(true);
    try {
      const payload = await readJson<InsightsData>(
        await fetch(
          "/api/support?" + new URLSearchParams({ mode: "insights", days: String(daysWindow) }),
          { cache: "no-store", signal: AbortSignal.timeout(25000) },
        ),
      );
      setInsights(payload);
    } catch (e) {
      if (!isTransientRequestError(e)) {
        setError(e instanceof Error ? e.message : "Could not load insights");
      }
    } finally {
      setInsightsLoading(false);
    }
  }, []);

  const ticket = data.selectedTicket?.id === selected ? data.selectedTicket : null;
  const ticketSingular =
    String((data.aiSettings as { ticketLabelSingular?: string } | undefined)?.ticketLabelSingular || "Ticket").trim() || "Ticket";
  const ticketPlural =
    String((data.aiSettings as { ticketLabelPlural?: string } | undefined)?.ticketLabelPlural || "Tickets").trim() || "Tickets";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") {
      params.delete("new");
      const nextSearch = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (nextSearch ? `?${nextSearch}` : ""));
      const timer = setTimeout(() => setNewTicketOpen(true), 0);
      return () => clearTimeout(timer);
    }
  }, []);
  const activeMessages = data.messages as Message[];
  const chatMessages = activeMessages.filter((m) => m.direction !== "note");
  const internalNotes = activeMessages.filter((m) => m.direction === "note");
  const activeCustomer = data.customer as CustomerInfo;
  const canManage =
    isAdmin ||
    Boolean(data.canManage) ||
    String(userRole || "")
      .toLowerCase()
      .split(",")
      .map((r) => r.trim())
      .some((r) => r === "admin" || r === "support_manager");

  const selectView = useCallback(
    (next: "tickets" | "queue" | "ai" | "insights" | "settings" | "logs") => {
      setViewMode(next);
      if (next === "tickets") {
        setQueue("all");
        setChannelFilter("all");
        setPage(1);
      } else if (next === "queue") {
        setQueue("human_queue");
        setChannelFilter("all");
        setPage(1);
        setSelected("");
      }
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (next === "tickets") {
          url.searchParams.delete("view");
        } else {
          url.searchParams.set("view", next);
        }
        window.history.replaceState(null, "", url.pathname + url.search);
      }
      if (next === "logs") {
        void loadLogs();
      } else if (next === "insights") {
        void loadInsights(insightsDays);
      }
    },
    [loadLogs, loadInsights, insightsDays]
  );

  useEffect(() => {
    if (!active) return;
    if (initialView === "logs") {
      const timer = setTimeout(() => void loadLogs(), 0);
      return () => clearTimeout(timer);
    }
    if (initialView === "insights") {
      const timer = setTimeout(() => void loadInsights(14), 0);
      return () => clearTimeout(timer);
    }
  }, [active, initialView, loadLogs, loadInsights]);

  useEffect(() => {
    if (!ticket?.id) return;
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [ticket?.id, chatMessages.length]);

  const openTicket = (ticketId: string) => {
    setSelected(ticketId);
    setBody("");
    setNoteBody("");
    setPendingAttachments([]);
    setActiveMacro(null);
    setStaleVersion(false);
    setLiveViewers([]);
    setRequestKey("");
  };

  const closeTicket = () => {
    if ((body.trim() || pendingAttachments.length > 0) && !confirm("Discard unsent draft?")) return;
    setSelected("");
    setBody("");
    setNoteBody("");
    setPendingAttachments([]);
    setActiveMacro(null);
    setStaleVersion(false);
    setLiveViewers([]);
    setRequestKey("");
  };

  const applyTemplate = (template: ReplyTemplate) => {
    const customerName = activeCustomer.name?.trim() || "there";
    const firstOrder = data.orders?.[0] as { channel_order_id?: string; id?: number } | undefined;
    const orderRef = firstOrder?.channel_order_id || (firstOrder?.id ? `#${firstOrder.id}` : "recent order");
    setBody(
      template.body
        .replaceAll("{{customer_name}}", customerName)
        .replaceAll("{{customer_email}}", ticket?.customer_email || activeCustomer.email || "")
        .replaceAll("{{order_id}}", orderRef)
    );
    const hasMacro =
      Boolean(template.macro_status) ||
      Boolean(template.macro_priority) ||
      Boolean(template.macro_tags?.length);
    setActiveMacro(
      hasMacro
        ? {
            templateName: template.name,
            macroStatus: template.macro_status || "",
            macroPriority: template.macro_priority || "",
            macroTags: template.macro_tags || [],
          }
        : null,
    );
  };

  // Detect /reply or /<shortcut> command at end or standalone line
  const templatesList = (data.templates || []) as ReplyTemplate[];
  const slashMatch = body.match(/(?:^|\s)\/([a-z0-9_-]*)$/i);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const slashTemplates =
    slashQuery !== null
      ? templatesList.filter((tpl) => {
          if (!slashQuery || slashQuery === "reply") return true;
          const cleanQuery = slashQuery.replace(/^reply[:\s-]*/, "");
          return (
            tpl.name.toLowerCase().includes(cleanQuery) ||
            String(tpl.shortcut || "").toLowerCase().includes(cleanQuery)
          );
        })
      : [];

  const selectSlashTemplate = (tpl: ReplyTemplate) => {
    const customerName = activeCustomer.name?.trim() || "there";
    const firstOrder = data.orders?.[0] as { channel_order_id?: string; id?: number } | undefined;
    const orderRef = firstOrder?.channel_order_id || (firstOrder?.id ? `#${firstOrder.id}` : "recent order");
    const filled = tpl.body
      .replaceAll("{{customer_name}}", customerName)
      .replaceAll("{{customer_email}}", ticket?.customer_email || activeCustomer.email || "")
      .replaceAll("{{order_id}}", orderRef);
    const cleaned = slashMatch
      ? body.slice(0, body.length - slashMatch[0].length).trimEnd()
      : body;
    setBody(cleaned ? `${cleaned}\n${filled}` : filled);
    const hasMacro =
      Boolean(tpl.macro_status) ||
      Boolean(tpl.macro_priority) ||
      Boolean(tpl.macro_tags?.length);
    setActiveMacro(
      hasMacro
        ? {
            templateName: tpl.name,
            macroStatus: tpl.macro_status || "",
            macroPriority: tpl.macro_priority || "",
            macroTags: tpl.macro_tags || [],
          }
        : null,
    );
    setSlashIndex(0);
  };

  async function handleAttachmentSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setError("");

    if (pendingAttachments.length + files.length > MAX_ATTACHMENT_COUNT) {
      setError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files per message.`);
      return;
    }

    let runningTotal = pendingAttachments.reduce((sum, a) => sum + a.size, 0);
    const added: PendingAttachment[] = [];

    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
        setError(`${file.name} exceeds the 4 MB per-file limit.`);
        return;
      }
      runningTotal += file.size;
      if (runningTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
        setError("Total attachment size cannot exceed 10 MB.");
        return;
      }
      added.push(await fileToBase64Attachment(file));
    }

    setPendingAttachments((curr) => [...curr, ...added]);
  }

  async function act(
    action: string,
    b: Record<string, unknown> = {},
    targetTicketId?: string,
    targetVersion?: number
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await readJson<{
        id?: string;
        messageId?: string;
        notice?: string;
        warning?: string;
        deliveryStatus?: string;
        deliveryError?: string;
        deleted?: boolean;
      }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ticketId: targetTicketId ?? selected,
            version: targetVersion ?? ticket?.version,
            ...b,
          }),
          signal: AbortSignal.timeout(action === "sync" ? 120000 : 30000),
        })
      );
      if (result.deleted) {
        setSelected("");
        setBody("");
        setPendingAttachments([]);
      }
      await load();
      if (result.deliveryError) {
        setError(result.deliveryError);
        // The message was persisted in support_messages (status='failed'), so return true for reply
        // so the composer resets and gets a fresh requestKey for the next reply.
        return action === "reply" && Boolean(result.messageId || result.id);
      }
      if (result.warning) {
        setNotice(result.notice || "Synced.");
        setError(result.warning);
        return true;
      }
      setNotice(result.notice || "Saved.");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(resolve = false) {
    if (!body.trim() && pendingAttachments.length === 0) return;
    const key = requestKey || crypto.randomUUID();
    setRequestKey(key);
    const attachmentPayload = pendingAttachments.map(({ name, mimeType, dataBase64 }) => ({
      name,
      mimeType,
      dataBase64,
    }));
    if (
      await act("reply", {
        body: body.trim(),
        requestKey: key,
        resolve,
        ...(activeMacro?.macroStatus ? { macroStatus: activeMacro.macroStatus } : {}),
        ...(activeMacro?.macroPriority ? { macroPriority: activeMacro.macroPriority } : {}),
        ...(activeMacro?.macroTags?.length ? { macroTags: activeMacro.macroTags } : {}),
        ...(attachmentPayload.length ? { attachments: attachmentPayload } : {}),
      })
    ) {
      setBody("");
      setPendingAttachments([]);
      setActiveMacro(null);
      setRequestKey("");
    }
  }

  async function sendNote() {
    if (!noteBody.trim()) return;
    if (
      await act("note", {
        body: noteBody.trim(),
        requestKey: crypto.randomUUID(),
      })
    ) {
      setNoteBody("");
    }
  }

  async function submitQuickTicket(e: React.FormEvent) {
    e.preventDefault();
    if (!newSubject.trim() || !newEmail.trim() || !newQuery.trim()) return;
    const ok = await act("create", {
      channel: "email",
      subject: newSubject.trim(),
      email: newEmail.trim(),
      query: newQuery.trim(),
      requestKey: crypto.randomUUID(),
    });
    if (ok) {
      setNewSubject("");
      setNewEmail("");
      setNewQuery("");
      setNewTicketOpen(false);
    }
  }

  const filtered = data.tickets;
  if (!active) return null;

  const channelTabs = [
    { key: "all" as const, label: "All", count: data.summary.open },
    { key: "facebook" as const, label: "Facebook", count: data.summary.facebook_open },
    { key: "instagram" as const, label: "Instagram", count: data.summary.instagram_open },
    { key: "email" as const, label: "Email", count: data.summary.email_open },
  ];

  const queueTabs = [
    { key: "all", label: "All Active", count: Number(data.summary.open) || undefined, tone: "" },
    {
      key: "ai_drafts",
      label: "AI Answered",
      count: Number(data.summary.ai_drafts) || undefined,
      tone: "green",
    },
    {
      key: "ai_needs_admin",
      label: "Needs Your Input",
      count: Number(data.summary.ai_needs_admin) || undefined,
      tone: "red",
    },
    {
      key: "ai_human_action",
      label: "Human Action / Callbacks",
      count: Number(data.summary.ai_human_action) || undefined,
      tone: "amber",
    },
    { key: "resolved", label: "Resolved", count: Number(data.summary.resolved) || undefined, tone: "" },
  ];

  const availableAgents = data.agents.filter((agent) => agent.available);
  const masonryColumns = packMasonryColumns(filtered, masonryCols);
  const gridColsClass =
    masonryCols === 1
      ? "grid-cols-1"
      : masonryCols === 2
        ? "grid-cols-2"
        : masonryCols === 3
          ? "grid-cols-3"
          : "grid-cols-4";

  const inTicketWorkspace = Boolean(ticket && viewMode === "tickets");
  const approvalModeEnabled = data.aiSettings?.approvalModeEnabled ?? true;
  const confidenceThresholdPercent = Math.round(
    (data.aiSettings?.autoReplyConfidenceThreshold ?? 0.82) * 100,
  );
  const envLiveOutboundEnabled = Boolean(data.aiSettings?.envLiveOutboundEnabled);

  type TicketListRow = Data["tickets"][number];

  const excelColumns: ExcelColumnDef<TicketListRow>[] = [
    {
      id: "customer",
      label: "Customer",
      defaultWidth: 165,
      minWidth: 110,
      sortable: true,
      sortValue: (t) =>
        String(t.external_username || t.customer_name || t.customer_email || "").toLowerCase(),
      renderCell: (t) => {
        const channelBadge = getChannelBadge(t.channel);
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`size-2 rounded-full shrink-0 ${channelBadge.dotClass}`} title={channelBadge.shortLabel} />
              <strong className="font-semibold text-foreground truncate">
                {t.external_username || t.customer_name || t.customer_email}
              </strong>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
              <span>#{String(t.ticket_number).padStart(4, "0")}</span>
              <span>·</span>
              <span>{formatShortDate(t.customer_last_at || t.updated_at)}</span>
            </div>
            {t.resolved_customer_phone && (
              <div className="inline-flex items-center gap-1 text-[10px] font-mono text-primary">
                <Phone size={10} /> {t.resolved_customer_phone}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "request",
      label: "Request Received",
      defaultWidth: 250,
      minWidth: 140,
      sortable: true,
      sortValue: (t) => String(t.subject || "").toLowerCase(),
      renderCell: (t) => {
        const queryText = cleanTicketPreviewText(
          String(t.customer_last_body || t.excerpt || ""),
          t.subject || `Inquiry from ${t.customer_name || t.customer_email}`,
        );
        return (
          <div className="space-y-0.5">
            {t.subject && (
              <p className="font-semibold text-foreground line-clamp-1">{t.subject}</p>
            )}
            <p className="text-muted-foreground leading-relaxed whitespace-pre-line">
              {queryText}
            </p>
          </div>
        );
      },
    },
    {
      id: "proposed",
      label: "Proposed Answer",
      defaultWidth: 270,
      minWidth: 150,
      sortable: true,
      sortValue: (t) => String(t.ai_reply_body || t.ai_question_for_admin || ""),
      renderCell: (t) => {
        if (t.ai_reply_body) {
          return (
            <div className="space-y-1">
              <p className="text-foreground leading-relaxed whitespace-pre-line">
                {t.ai_reply_body}
              </p>
              {t.ai_confidence != null && (
                <span className="inline-block rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-mono font-semibold text-success">
                  Confidence: {Math.round(Number(t.ai_confidence) * 100)}%
                </span>
              )}
            </div>
          );
        }
        if (t.ai_question_for_admin) {
          return (
            <div className="space-y-1 text-amber-800 dark:text-amber-300">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase">
                <AlertTriangle size={10} /> Needs Human Input
              </span>
              <p className="leading-snug">{t.ai_question_for_admin}</p>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground italic">No AI proposal yet</span>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void act("ai_run_ticket", {}, t.id);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground transition cursor-pointer"
            >
              <Sparkles size={10} /> Run AI
            </button>
          </div>
        );
      },
    },
    {
      id: "tracking",
      label: "Order & Tracking",
      defaultWidth: 145,
      minWidth: 110,
      sortable: true,
      sortValue: (t) => String(t.order_tracking_id || t.order_code || ""),
      renderCell: (t) => {
        if (!t.order_code && !t.order_tracking_id) {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <div className="space-y-1">
            {t.order_code && (
              <div className="inline-flex items-center gap-1 font-mono font-semibold text-foreground">
                <Package size={11} className="text-primary" /> {t.order_code}
              </div>
            )}
            {t.order_tracking_id ? (
              <div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTrackingTarget({
                      awb: String(t.order_tracking_id),
                      orderId: t.order_id ? Number(t.order_id) : null,
                      orderCode: String(t.order_code || ""),
                      ticketId: t.id,
                      courier: String(t.order_courier || ""),
                    });
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground transition cursor-pointer"
                  title="One-click order tracking info"
                >
                  <Truck size={10} /> {t.order_tracking_id}
                </button>
              </div>
            ) : (
              <span className="block text-[10px] text-muted-foreground">No AWB yet</span>
            )}
          </div>
        );
      },
    },
    {
      id: "status",
      label: "Status",
      defaultWidth: 110,
      minWidth: 85,
      sortable: true,
      sortValue: (t) => String(t.ai_status || t.status || ""),
      renderCell: (t) => {
        const statusStyle = getStatusBadgeStyle(t.status);
        if (t.status === "resolved") {
          return (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle.badge}`}>
              Resolved
            </span>
          );
        }
        if (t.ai_status === "auto_replied" || t.ai_approval_status === "auto_sent") {
          return (
            <span className="inline-flex items-center gap-1 rounded-full border border-success/35 bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">
              Auto-Sent
            </span>
          );
        }
        if (t.ai_status === "needs_human_action" || t.ai_status === "needs_admin_input") {
          return (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-300">
              Human Queue
            </span>
          );
        }
        if (t.ai_reply_body) {
          return (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
              Pending Review
            </span>
          );
        }
        return (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle.badge}`}>
            {statusStyle.label}
          </span>
        );
      },
    },
    {
      id: "actions",
      label: "Approve / Decline",
      defaultWidth: 165,
      minWidth: 155,
      sortable: false,
      renderCell: (t) => {
        const queryText = cleanTicketPreviewText(
          String(t.customer_last_body || t.excerpt || ""),
          t.subject || "",
        );
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={busy || !t.ai_reply_body}
              onClick={(e) => {
                e.stopPropagation();
                void act(
                  "ai_approve_reply",
                  {
                    proposedReply: t.ai_reply_body,
                    requestKey: crypto.randomUUID(),
                  },
                  t.id,
                  t.version,
                );
              }}
              title={t.ai_reply_body ? "Approve & send AI response" : "Run AI first to generate a proposed answer"}
              className="inline-flex items-center gap-1 rounded-lg bg-success px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={12} /> Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                setDeclineTarget({
                  id: t.id,
                  ticketNumber: Number(t.ticket_number),
                  customerLabel: String(t.external_username || t.customer_name || t.customer_email || ""),
                  customerQuery: queryText,
                  proposedReply: String(t.ai_reply_body || ""),
                  version: Number(t.version),
                });
              }}
              title="Decline AI response, enter reason & send corrected answer"
              className="inline-flex items-center gap-1 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive hover:text-white transition cursor-pointer disabled:opacity-40"
            >
              <XCircle size={12} /> Decline
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div
      className={`${
        inTicketWorkspace ? "h-screen overflow-hidden" : "min-h-screen"
      } bg-background text-foreground flex`}
    >
      {dialog}

      <SupportSidebar
        activeNav={viewMode}
        canManage={canManage}
        isAdmin={isAdmin || userRole === "admin"}
        nomenclature={{ singular: ticketSingular, plural: ticketPlural }}
        openCount={Number(data.summary.open || 0)}
        humanQueueCount={Number(data.summary.ai_needs_admin || 0)}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        onSelectView={(next) => {
          if (selected) {
            setSelected("");
          }
          selectView(next);
        }}
      />

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <SupportTopBar
        activeNav={viewMode}
        canManage={canManage}
        isAdmin={isAdmin || userRole === "admin"}
        userLabel={userLabel}
        userEmail={userEmail}
        nomenclature={{ singular: ticketSingular, plural: ticketPlural }}
        searchValue={search}
        onSearchChange={(next) => {
          setSearch(next);
          setPage(1);
          if (viewMode !== "tickets") selectView("tickets");
        }}
        onOpenMobileMenu={() => setMobileMenuOpen(true)}
        onSelectView={(next) => {
          if (selected) {
            setSelected("");
          }
          selectView(next);
        }}
        onOpenNewTicket={() => setNewTicketOpen(true)}
        onSync={() => void act("sync")}
        busy={busy}
        approvalModeEnabled={approvalModeEnabled}
        confidenceThresholdPercent={confidenceThresholdPercent}
        onToggleApprovalMode={() =>
          void act("ai_settings_update", {
            approvalModeEnabled: !approvalModeEnabled,
          })
        }
      />

      {/* MAIN FULL-WIDTH CONTENT */}
      {!inTicketWorkspace && (
      <main className="flex-1 min-w-0">
        <div className="mx-auto w-full max-w-[1640px] px-4 sm:px-6 py-4 space-y-4">
          {/* Error / Notice Banners */}
          {error && (
            <div
              className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs font-medium text-destructive"
              role="alert"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError("")}
                className="rounded-md border border-destructive/30 px-2.5 py-0.5 text-[11px] font-semibold hover:bg-destructive/15"
              >
                Dismiss
              </button>
            </div>
          )}

          {notice && (
            <div
              className="flex items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-2.5 text-xs font-medium text-success"
              role="status"
            >
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice("")}
                className="rounded-md border border-success/30 px-2.5 py-0.5 text-[11px] font-semibold hover:bg-success/15"
              >
                OK
              </button>
            </div>
          )}

          {/* Bulk Selection Bar */}
          {canManage && viewMode === "tickets" && selectedTickets.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-accent/50 px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setSelectedTickets([])}
                  title="Clear selection"
                  aria-label="Clear selection"
                  className="flex size-7 items-center justify-center rounded-md text-accent-foreground hover:bg-accent cursor-pointer"
                >
                  <X size={15} />
                </button>
                <strong className="font-semibold text-accent-foreground">
                  {selectedTickets.length} selected
                </strong>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Bulk assign agent"
                  value={bulkAssignee}
                  onChange={(event) => setBulkAssignee(event.target.value)}
                  className="h-8 rounded-lg border border-input bg-card px-2.5 text-xs text-foreground outline-none focus:border-ring"
                >
                  <option value="">Assign to agent…</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.user_id} value={agent.user_id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  disabled={busy || !bulkAssignee}
                  onClick={async () => {
                    if (
                      await act("bulk_assign", {
                        ticketIds: selectedTickets,
                        agentId: bulkAssignee,
                      })
                    ) {
                      setSelectedTickets([]);
                      setBulkAssignee("");
                    }
                  }}
                >
                  <UserRoundCheck size={14} /> Assign
                </Button>
              </div>
            </div>
          )}

          {/* VIEW: HUMAN INTERVENTION QUEUE (CHAT-ONLY ONE-BY-ONE) */}
          {viewMode === "queue" ? (
            <SupportErrorBoundary fallbackTitle="Agent Queue failed to render">
              <AgentQueueView
                queueTickets={filtered}
                activeTicketId={selected}
                selectedTicket={ticket}
                messages={activeMessages}
                orders={data.orders || []}
                customer={activeCustomer}
                busy={busy}
                onSelectTicket={(ticketId) => setSelected(ticketId)}
                onSendAiResponse={async (ticketId, proposedBody, version) =>
                  act(
                    "ai_approve_reply",
                    { proposedReply: proposedBody, requestKey: crypto.randomUUID() },
                    ticketId,
                    version,
                  )
                }
                onSendCorrectedResponse={async (payload) =>
                  act(
                    "ai_decline_reply",
                    {
                      customerQuery: payload.customerQuery,
                      proposedReply: payload.proposedReply,
                      declineReason: payload.declineReason,
                      correctedReply: payload.correctedReply,
                      requestKey: crypto.randomUUID(),
                    },
                    payload.ticketId,
                    payload.version,
                  )
                }
                onTrackOrder={(target) => setTrackingTarget(target)}
              />
            </SupportErrorBoundary>
          ) : viewMode === "ai" && canManage ? (
            <SupportErrorBoundary fallbackTitle="AI & RAG view failed to render">
              <SupportAiKnowledgeView
                knowledgeSummary={data.aiKnowledgeSummary}
                onOpenTicket={(ticketId) => {
                  selectView("tickets");
                  openTicket(ticketId);
                }}
                onRefreshDashboard={() => void load()}
              />
            </SupportErrorBoundary>
          ) : viewMode === "insights" && canManage ? (
            <SupportErrorBoundary fallbackTitle="Insights view failed to render">
              <SupportInsightsView
                insights={insights}
                loading={insightsLoading}
                days={insightsDays}
                onChangeDays={(d) => {
                  setInsightsDays(d);
                  void loadInsights(d);
                }}
                onRefresh={() => void loadInsights(insightsDays)}
                onBack={() => selectView("tickets")}
              />
            </SupportErrorBoundary>
          ) : viewMode === "settings" && canManage ? (
            <SupportErrorBoundary fallbackTitle="Settings view failed to render">
              <SupportSettingsView
                data={data}
                isAdmin={isAdmin}
                userRole={userRole}
                busy={busy}
                ticketPlural={ticketPlural}
                onBack={() => selectView("tickets")}
                onAct={(action, b) => act(action, b)}
                onRefresh={async () => {
                  await load();
                }}
                onError={setError}
                onNotice={setNotice}
              />
            </SupportErrorBoundary>
          ) : viewMode === "logs" && canManage ? (
            <SupportErrorBoundary fallbackTitle="Activity log failed to render">
              <SupportLogsView
                logs={logs}
                logsLoading={logsLoading}
                onRefresh={() => void loadLogs()}
                onBack={() => selectView("tickets")}
              />
            </SupportErrorBoundary>
          ) : (
            /* VIEW: AI-FIRST AUTONOMOUS TICKET INBOX */
            <>
              {/* AI Autopilot Top Bar */}
              <div className="panel p-3.5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {queueTabs.map((qt) => {
                    const isActive = queue === qt.key;
                    return (
                      <button
                        key={qt.key}
                        type="button"
                        onClick={() => {
                          setQueue(qt.key);
                          setPage(1);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                          isActive
                            ? "border-primary bg-primary text-primary-foreground shadow-xs"
                            : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        <span>{qt.label}</span>
                        {qt.count !== undefined && (
                          <span
                            className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono font-bold ${
                              isActive
                                ? "bg-white/20 text-primary-foreground"
                                : qt.tone === "red"
                                  ? "bg-destructive/15 text-destructive"
                                  : qt.tone === "green"
                                    ? "bg-success/15 text-success"
                                    : "bg-card text-foreground"
                            }`}
                          >
                            {qt.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Filter by channel"
                    value={channelFilter}
                    onChange={(e) => {
                      setChannelFilter(e.target.value as "all" | "email" | "instagram" | "facebook");
                      setPage(1);
                    }}
                    className="h-8 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground outline-none focus:border-ring cursor-pointer"
                  >
                    {channelTabs.map((ch) => (
                      <option key={ch.key} value={ch.key}>
                        {ch.key === "all" ? "All Channels" : ch.label}
                        {Number(ch.count || 0) > 0 ? ` (${ch.count})` : ""}
                      </option>
                    ))}
                  </select>

                  {canManage && (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act("ai_batch_triage")}
                        className="h-7 px-2.5 text-[11px]"
                      >
                        <Sparkles size={12} /> Auto-Answer Batch (AI)
                      </Button>

                      <button
                        type="button"
                        title={
                          listLayout === "grid" ? "Switch to table view" : "Switch to card view"
                        }
                        aria-label={
                          listLayout === "grid" ? "Switch to table view" : "Switch to card view"
                        }
                        onClick={() => setListLayout((l) => (l === "grid" ? "list" : "grid"))}
                        className="flex size-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition hover:border-primary/40 hover:text-foreground cursor-pointer"
                      >
                        {listLayout === "grid" ? <Rows3 size={13} /> : <LayoutGrid size={13} />}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Ticket Canvas: Loading / Empty / Excel Review Table / Simplified Cards */}
              {!loaded ? (
                <div className="panel py-20 flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
                  <div className="size-7 rounded-full border-2 border-border border-t-primary animate-spin" />
                  <p className="text-xs">Loading support queries…</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="panel py-20 px-6 flex flex-col items-center justify-center text-center gap-2">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-2">
                    <Mail size={22} />
                  </div>
                  <h2 className="text-base font-semibold text-foreground">
                    {search ? "No matching queries" : "Inbox is clear"}
                  </h2>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    {search
                      ? "Try clearing your search or switching channels."
                      : canManage
                        ? "Customer emails, Instagram DMs, and Facebook messages will appear here."
                        : "Assigned customer support queries will show here."}
                  </p>
                </div>
              ) : canManage && (approvalModeEnabled || listLayout === "list") ? (
                <ExcelReviewTable
                  rows={filtered}
                  columns={excelColumns}
                  rowKey={(t) => t.id}
                  storageKey="satmi_support_review"
                  defaultRowHeight={46}
                  defaultRowHeightMode="autofit"
                  onRowClick={(t) => openTicket(t.id)}
                  isRowSelected={(t) => selected === t.id || selectedTickets.includes(t.id)}
                  toolbarExtra={
                    !approvalModeEnabled ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/35 bg-success/10 px-2.5 py-0.5 text-[11px] font-semibold text-success">
                        <Sparkles size={11} />
                        Auto-Send ON (Confidence ≥ {confidenceThresholdPercent}%
                        {!envLiveOutboundEnabled ? " · Env Gate Held" : ""})
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Approval Mode ON · Drag column/row edges to resize
                      </span>
                    )
                  }
                />
              ) : (
                /* SIMPLIFIED UNIFORM CARDS */
                <div className={`grid ${gridColsClass} gap-3 items-stretch`}>
                  {masonryColumns.flat().map((t) => {
                    const isChecked = selectedTickets.includes(t.id);
                    const isSelected = selected === t.id;
                    const cleanQuery = cleanTicketPreviewText(
                      String(t.customer_last_body || t.excerpt || ""),
                      t.subject || `Inquiry from ${t.external_username || t.customer_name || t.customer_email}`,
                    );
                    const statusStyle = getStatusBadgeStyle(t.status);
                    const channelBadge = getChannelBadge(t.channel);

                    return (
                      <div
                        key={t.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openTicket(t.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openTicket(t.id);
                          }
                        }}
                        className={`group panel p-3.5 flex flex-col justify-between gap-2.5 text-left transition cursor-pointer hover:border-primary/45 ${
                          isSelected || isChecked ? "ring-2 ring-primary border-primary" : ""
                        }`}
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                              <span className={`size-2 rounded-full ${channelBadge.dotClass}`} />
                              {channelBadge.shortLabel} · #{String(t.ticket_number).padStart(4, "0")}
                            </span>
                            {t.ai_reply_body ? (
                              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">
                                Proposed{t.ai_confidence != null ? ` · ${Math.round(Number(t.ai_confidence) * 100)}%` : ""}
                              </span>
                            ) : t.ai_status === "needs_human_action" || t.ai_status === "needs_admin_input" ? (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-300">
                                Needs Human
                              </span>
                            ) : (
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusStyle.badge}`}>
                                {statusStyle.label}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-bold text-foreground truncate">
                              {t.external_username || t.customer_name || t.customer_email}
                            </p>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {formatShortDate(t.customer_last_at || t.updated_at)}
                            </span>
                          </div>

                          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                            {cleanQuery}
                          </p>
                        </div>

                        <div className="pt-2 border-t border-border/50 flex items-center justify-between gap-2 text-[11px]">
                          {t.order_tracking_id ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setTrackingTarget({
                                  awb: String(t.order_tracking_id),
                                  orderId: t.order_id ? Number(t.order_id) : null,
                                  orderCode: String(t.order_code || ""),
                                  ticketId: t.id,
                                  courier: String(t.order_courier || ""),
                                });
                              }}
                              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground transition cursor-pointer"
                            >
                              <Truck size={10} /> {t.order_tracking_id}
                            </button>
                          ) : (
                            <span className="text-muted-foreground truncate">
                              {t.ai_reply_body ? "AI reply ready" : "Click to open"}
                            </span>
                          )}
                          <span className="font-semibold text-primary group-hover:underline shrink-0">
                            Open →
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Clean Bottom Pagination */}
              {data.totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2 text-xs text-muted-foreground">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <span className="font-mono text-xs">
                    Page {page} of {data.totalPages} ({data.total})
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    disabled={page >= data.totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      )}

      {/* IN-SHELL TICKET CHAT WORKSPACE (keeps SupportTopBar visible) */}
      {inTicketWorkspace && ticket && (
        <div
          className="flex-1 min-h-0 bg-background text-foreground flex flex-col overflow-hidden"
          aria-label={ticket.subject}
        >
          {/* Top Header */}
          <header className="shrink-0 border-b border-border bg-card px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 min-w-0 flex-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={closeTicket}
                className="h-8 px-2.5 text-xs shrink-0"
              >
                <ArrowLeft size={14} /> Back
              </Button>

              {(() => {
                const ch = getChannelBadge(ticket.channel);
                return (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold shrink-0 ${ch.className}`}
                  >
                    <span className={`size-1.5 rounded-full ${ch.dotClass}`} />
                    {ch.shortLabel}
                  </span>
                );
              })()}

              <div className="min-w-0 max-w-md mr-1">
                <h2 className="truncate text-sm sm:text-base font-bold text-foreground leading-tight">
                  {activeCustomer.name ||
                    ticket.external_username ||
                    ticket.customer_name ||
                    ticket.customer_email}
                </h2>
                <p className="truncate text-[11px] text-muted-foreground">
                  #{String(ticket.ticket_number).padStart(4, "0")} · {ticket.subject}
                </p>
              </div>

              <select
                aria-label="Status"
                disabled={busy}
                value={ticket.status}
                onChange={(event) => void act("status", { status: event.target.value })}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs font-medium text-foreground capitalize outline-none focus:border-ring"
              >
                {["open", "in_progress", "waiting", "escalated", "resolved"].map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </select>

              {canManage ? (
                <select
                  aria-label="Assignee"
                  disabled={busy}
                  value={ticket.assignee_id || ""}
                  onChange={(event) => void act("assign", { agentId: event.target.value })}
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs font-medium text-foreground outline-none focus:border-ring"
                >
                  <option value="">Unassigned</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.user_id} value={agent.user_id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-foreground">
                  <UserCheck size={12} className="text-primary" />
                  {data.agents.find((a) => a.user_id === ticket.assignee_id)?.name || userLabel}
                </span>
              )}
            </div>

            {/* Top-Right: SLA + Priority + Notes + Escalate + Remove (manager only) */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {(() => {
                const sla = evaluateSlaState({
                  ...ticket,
                  last_direction: chatMessages[chatMessages.length - 1]?.direction || "inbound",
                });
                if (sla.state !== "breached" && sla.state !== "due_soon") return null;
                return (
                  <span
                    className={`inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-bold ${
                      sla.state === "breached"
                        ? "bg-destructive/15 text-destructive border border-destructive/30"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                    }`}
                  >
                    <Clock size={12} /> {sla.label}
                  </span>
                );
              })()}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hidden sm:inline">
                  Priority
                </span>
                <select
                  aria-label="Priority"
                  disabled={busy}
                  value={ticket.priority}
                  onChange={(event) => void act("priority", { priority: event.target.value })}
                  className={`h-8 rounded-full px-3 text-xs font-semibold capitalize outline-none cursor-pointer ${getPriorityBadgeStyle(
                    ticket.priority
                  )}`}
                >
                  {["low", "normal", "high", "urgent"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={() => {
                  setNotesPanelOpen((prev) => {
                    if (typeof window !== "undefined" && window.innerWidth < 1024) {
                      return !prev;
                    }
                    return true;
                  });
                  setTimeout(() => noteInputRef.current?.focus(), 60);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition cursor-pointer"
              >
                <StickyNote size={13} />
                <span>Notes</span>
                <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-mono">
                  {internalNotes.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDetailsSidebarOpen((prev) => !prev);
                  setNotesPanelOpen(true);
                }}
                title={detailsSidebarOpen ? "Hide customer & notes panel" : "Show customer & notes panel"}
                className="hidden lg:inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted transition cursor-pointer"
              >
                {detailsSidebarOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                <span>Details</span>
              </button>

              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={async () => {
                  const response = await requestEntry(`Escalate ${ticketSingular.toLowerCase()}`, [
                    { name: "reason", label: "Escalation reason" },
                  ]);
                  if (response?.reason) void act("escalate", { reason: response.reason });
                }}
              >
                <ArrowUpRight size={14} /> <span className="hidden sm:inline">Escalate</span>
              </Button>

              {canManage && (
                <button
                  type="button"
                  title={`Remove ${ticketSingular.toLowerCase()}`}
                  aria-label={`Remove ${ticketSingular.toLowerCase()}`}
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Permanently remove this ${ticketSingular.toLowerCase()} from the dashboard?`)) {
                      void act("delete_ticket");
                    }
                  }}
                  className="flex size-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive transition cursor-pointer disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </header>

          {/* Soft Collision & Live Presence Banner */}
          {(liveViewers.length > 0 || staleVersion) && (
            <div className="shrink-0 px-4 sm:px-6 pt-2.5 space-y-2 bg-muted/20 dark:bg-background">
              <div
                className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2 text-xs font-medium ${
                  staleVersion
                    ? "border-destructive/35 bg-destructive/10 text-destructive"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                }`}
                role="status"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>
                    {staleVersion
                      ? "This ticket was updated by another teammate while you had it open."
                      : `${liveViewers.map((v) => v.name).join(", ")} ${
                          liveViewers.length === 1 ? "is" : "are"
                        } also viewing this ticket.`}
                  </span>
                </div>
                {staleVersion && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => void load()}
                  >
                    <RefreshCw size={11} /> Refresh thread
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* In-Workspace Error / Notice */}
          {(error || notice) && (
            <div className="shrink-0 px-4 sm:px-6 pt-3 space-y-2 bg-muted/20 dark:bg-background">
              {error && (
                <div
                  className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive"
                  role="alert"
                >
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setError("")}
                    className="rounded-md border border-destructive/30 px-2 py-0.5 text-[11px] font-semibold hover:bg-destructive/15"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {notice && (
                <div
                  className="flex items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-2 text-xs font-medium text-success"
                  role="status"
                >
                  <span>{notice}</span>
                  <button
                    type="button"
                    onClick={() => setNotice("")}
                    className="rounded-md border border-success/30 px-2 py-0.5 text-[11px] font-semibold hover:bg-success/15"
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          )}

          {/* AI Assistant, 10,000-Token Rolling Compactor & Admin Clarification -> Rephrase -> Memory Card */}
          <TicketAiAssistantCard
            ticket={{
              id: String(ticket.id),
              channel: String(ticket.channel || "email"),
              customer_name: String(ticket.customer_name || ""),
              customer_email: String(ticket.customer_email || ""),
              external_username: String(ticket.external_username || ""),
              subject: String(ticket.subject || ""),
              ai_status: String(ticket.ai_status || "idle"),
              ai_confidence: ticket.ai_confidence as number | string | null,
              ai_summary: String(ticket.ai_summary || ""),
              ai_summary_tokens: Number(ticket.ai_summary_tokens || 0),
              ai_pinned_facts: ticket.ai_pinned_facts as Record<string, unknown> | string | null,
            }}
            escalations={(data.aiEscalations || []) as AiEscalationItem[]}
            threadTokenEstimate={Number(data.aiThreadTokenEstimate || 0)}
            compactionThreshold={Number(data.aiSettings?.compactionTokenThreshold || 10000)}
            approvalModeEnabled={approvalModeEnabled}
            latestInboundText={
              [...chatMessages]
                .reverse()
                .find((m) => m.direction === "inbound")?.body ||
              String(ticket.subject || "")
            }
            onLoadIntoComposer={(rephrasedBody) => setBody(rephrasedBody)}
            onRefreshTicket={async () => {
              await load();
            }}
          />

          {/* Split Body */}
          <div
            className={`flex-1 min-h-0 grid grid-cols-1 overflow-hidden ${
              detailsSidebarOpen ? "lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_390px]" : ""
            }`}
          >
            {/* LEFT/CENTER: CHAT THREAD + COMPOSER */}
            <section className="min-w-0 min-h-0 flex flex-col bg-muted/20 dark:bg-background overflow-hidden">
              <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-5 space-y-3">
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground py-12 gap-2">
                    <MessageSquare size={26} className="opacity-40" />
                    <p className="text-xs">No conversation messages yet.</p>
                  </div>
                ) : (
                  chatMessages.map((m) => {
                    const isOutbound = m.direction === "outbound";
                    return (
                      <div
                        key={m.id}
                        className={`flex w-full ${isOutbound ? "justify-end" : "justify-start"}`}
                      >
                        <article
                          className={`max-w-[84%] sm:max-w-[70%] rounded-2xl border px-4 py-3 text-sm shadow-xs ${
                            isOutbound
                              ? "rounded-tr-sm border-primary/30 bg-primary/10 dark:bg-primary/15 text-foreground"
                              : "rounded-tl-sm border-border bg-card text-card-foreground"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground mb-1.5">
                            <strong className="font-semibold text-foreground truncate">
                              {isOutbound
                                ? `Satmi Support · ${m.sender || data.connection.email}`
                                : activeCustomer.name ||
                                  ticket.external_username ||
                                  ticket.customer_name ||
                                  m.sender ||
                                  "Customer"}
                            </strong>
                            <div className="flex items-center gap-2 shrink-0">
                              <time className="text-[10px]">{formatShortDate(m.created_at)}</time>
                              {isOutbound && (
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                    m.delivery_status === "sent"
                                      ? "bg-success/15 text-success"
                                      : m.delivery_status === "failed"
                                        ? "bg-destructive/15 text-destructive"
                                        : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {m.delivery_status === "sent"
                                    ? "Sent"
                                    : m.delivery_status === "failed"
                                      ? "Failed"
                                      : m.delivery_status === "ai_draft"
                                        ? "AI Draft (Safe Mode · Not Sent)"
                                        : "Queued"}
                                </span>
                              )}
                            </div>
                          </div>

                          {(() => {
                            const { cleanBody, urls: legacyUrls } = extractLegacyAttachmentUrls(
                              visibleEmailBody(m.body || "")
                            );
                            const structuredAtts = m.attachments || [];
                            return (
                              <>
                                {cleanBody && (
                                  <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                                    {cleanBody}
                                  </div>
                                )}

                                {m.delivery_status === "ai_draft" && (
                                  <div className="mt-2.5 flex flex-wrap items-center gap-2 pt-2 border-t border-primary/20">
                                    <Button
                                      variant="primary"
                                      size="sm"
                                      className="h-7 px-2.5 text-xs"
                                      disabled={busy}
                                      onClick={() => setBody(visibleEmailBody(m.body))}
                                    >
                                      <Sparkles size={12} /> Load Draft into Reply Box
                                    </Button>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      className="h-7 px-2.5 text-xs"
                                      disabled={busy}
                                      onClick={() => void act("ai_discard_draft")}
                                    >
                                      Discard AI Draft
                                    </Button>
                                  </div>
                                )}

                                {(structuredAtts.length > 0 || legacyUrls.length > 0) && (
                                  <div className="mt-2.5 space-y-2">
                                    {/* Inline Image Attachments */}
                                    <div className="flex flex-wrap gap-2">
                                      {structuredAtts
                                        .filter((a) => isImageAttachment(a))
                                        .map((a) => {
                                          const inlineSrc =
                                            "/api/support/attachment?" +
                                            new URLSearchParams({
                                              message: m.id,
                                              attachment: a.attachmentId,
                                              inline: "1",
                                            });
                                          const downloadSrc =
                                            "/api/support/attachment?" +
                                            new URLSearchParams({
                                              message: m.id,
                                              attachment: a.attachmentId,
                                            });
                                          return (
                                            <div
                                              key={a.attachmentId}
                                              className="group relative overflow-hidden rounded-xl border border-border bg-background/80"
                                            >
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  setLightboxImage({
                                                    src: inlineSrc,
                                                    name: a.name,
                                                    downloadUrl: downloadSrc,
                                                  })
                                                }
                                                className="block cursor-zoom-in"
                                                title={`Preview ${a.name}`}
                                              >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                  src={inlineSrc}
                                                  alt={a.name}
                                                  loading="lazy"
                                                  className="max-h-56 max-w-[260px] object-cover transition group-hover:opacity-95"
                                                />
                                              </button>
                                              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] bg-card/90 border-t border-border">
                                                <span className="truncate max-w-[160px] font-medium text-foreground">
                                                  {a.name}
                                                </span>
                                                <a
                                                  href={downloadSrc}
                                                  download={a.name}
                                                  className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
                                                  title={`Download ${a.name}`}
                                                >
                                                  <Download size={11} />
                                                </a>
                                              </div>
                                            </div>
                                          );
                                        })}

                                      {legacyUrls.map((url, idx) => (
                                        <div
                                          key={`${m.id}-legacy-${idx}`}
                                          className="group relative overflow-hidden rounded-xl border border-border bg-background/80"
                                        >
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setLightboxImage({
                                                src: url,
                                                name: `Attachment ${idx + 1}`,
                                                downloadUrl: url,
                                              })
                                            }
                                            className="block cursor-zoom-in"
                                          >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                              src={url}
                                              alt={`Attachment ${idx + 1}`}
                                              loading="lazy"
                                              className="max-h-56 max-w-[260px] object-cover"
                                            />
                                          </button>
                                          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] bg-card/90 border-t border-border">
                                            <span className="font-medium text-foreground">Media {idx + 1}</span>
                                            <a
                                              href={url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex items-center gap-1 text-primary hover:underline"
                                            >
                                              <ExternalLink size={11} />
                                            </a>
                                          </div>
                                        </div>
                                      ))}
                                    </div>

                                    {/* Non-Image File Attachments (PDF, Docs, Audio, Video, etc.) */}
                                    <div className="flex flex-wrap gap-2">
                                      {structuredAtts
                                        .filter((a) => !isImageAttachment(a))
                                        .map((a) => {
                                          const downloadSrc =
                                            "/api/support/attachment?" +
                                            new URLSearchParams({
                                              message: m.id,
                                              attachment: a.attachmentId,
                                            });
                                          const inlineSrc =
                                            "/api/support/attachment?" +
                                            new URLSearchParams({
                                              message: m.id,
                                              attachment: a.attachmentId,
                                              inline: "1",
                                            });
                                          const canInlineOpen = isPdfAttachment(a);
                                          return (
                                            <div
                                              key={a.attachmentId}
                                              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background/90 px-3 py-2 text-xs font-medium text-foreground"
                                            >
                                              <FileText size={15} className="text-primary shrink-0" />
                                              <div className="min-w-0">
                                                <p className="truncate max-w-[180px] font-medium">
                                                  {a.name}
                                                </p>
                                                {typeof a.size === "number" && a.size > 0 && (
                                                  <p className="text-[10px] text-muted-foreground">
                                                    {formatBytes(a.size)}
                                                  </p>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-1 ml-1">
                                                {canInlineOpen && (
                                                  <a
                                                    href={inlineSrc}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition"
                                                    title="Open in new tab"
                                                  >
                                                    <ExternalLink size={13} />
                                                  </a>
                                                )}
                                                <a
                                                  href={downloadSrc}
                                                  download={a.name}
                                                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-primary transition"
                                                  title={`Download ${a.name}`}
                                                >
                                                  <Download size={13} />
                                                </a>
                                              </div>
                                            </div>
                                          );
                                        })}
                                    </div>
                                  </div>
                                )}
                              </>
                            );
                          })()}

                          {m.last_error && (
                            <p className="mt-2 text-xs font-medium text-destructive">{m.last_error}</p>
                          )}

                          {m.delivery_status === "failed" && (
                            <div className="mt-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                disabled={busy}
                                onClick={() => void act("retry", { messageId: m.id })}
                              >
                                Retry send
                              </Button>
                            </div>
                          )}
                        </article>
                      </div>
                    );
                  })
                )}
                <div ref={threadEndRef} />
              </div>

              {/* Bottom Chat Composer */}
              <footer className="relative shrink-0 border-t border-border bg-card px-4 sm:px-6 py-3 space-y-2.5">
                {/* /reply Slash Command Popover */}
                {slashQuery !== null && slashTemplates.length > 0 && (
                  <div
                    className="absolute bottom-full left-4 sm:left-6 right-4 sm:right-6 mb-2 rounded-2xl border border-border bg-card shadow-float p-2 z-20 max-h-60 overflow-y-auto"
                    role="listbox"
                    aria-label="Quick reply commands"
                  >
                    <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Quick responses &amp; macros (↑↓ Enter to insert, Esc to close)
                    </div>
                    {slashTemplates.map((tpl, idx) => {
                      const activeRow = idx === Math.min(slashIndex, slashTemplates.length - 1);
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectSlashTemplate(tpl);
                          }}
                          className={`w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs transition cursor-pointer ${
                            activeRow
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted/60 text-foreground"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <strong className="font-semibold truncate">{tpl.name}</strong>
                              {tpl.shortcut && (
                                <span className="rounded bg-primary/15 px-1.5 py-0.2 font-mono text-[10px] text-primary">
                                  /{tpl.shortcut}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {tpl.body}
                            </p>
                          </div>
                          {(tpl.macro_status || tpl.macro_priority || tpl.macro_tags?.length) && (
                            <div className="flex flex-wrap items-center gap-1 shrink-0">
                              {tpl.macro_status && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize">
                                  → {tpl.macro_status.replaceAll("_", " ")}
                                </span>
                              )}
                              {tpl.macro_tags?.map((tg) => (
                                <span
                                  key={tg}
                                  className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                                >
                                  +{tg}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Quick Replies Popover (opened from toolbar button) */}
                {quickRepliesOpen && (
                  <div className="absolute bottom-full left-4 sm:left-6 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card shadow-float p-2 z-20 max-h-64 overflow-y-auto">
                    <div className="flex items-center justify-between px-2.5 py-1 border-b border-border/60 mb-1">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                        Quick Replies &amp; Macros
                      </span>
                      <div className="flex items-center gap-2">
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => {
                              setQuickRepliesOpen(false);
                              setTemplatesOpen(true);
                            }}
                            className="text-[11px] font-semibold text-primary hover:underline cursor-pointer"
                          >
                            Manage
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setQuickRepliesOpen(false)}
                          className="text-muted-foreground hover:text-foreground cursor-pointer"
                          aria-label="Close quick replies"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                    {templatesList.length > 0 ? (
                      templatesList.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => {
                            applyTemplate(tpl);
                            setQuickRepliesOpen(false);
                          }}
                          className="w-full flex flex-col items-start rounded-xl px-2.5 py-2 text-left text-xs hover:bg-muted/60 transition cursor-pointer"
                        >
                          <div className="flex items-center gap-2 w-full">
                            <strong className="font-semibold text-foreground truncate">{tpl.name}</strong>
                            {tpl.shortcut && (
                              <span className="rounded bg-primary/15 px-1.5 py-0.2 font-mono text-[10px] text-primary">
                                /{tpl.shortcut}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate w-full mt-0.5">
                            {tpl.body}
                          </p>
                        </button>
                      ))
                    ) : (
                      <p className="px-2.5 py-3 text-xs text-muted-foreground">
                        No templates yet. Type <code className="font-mono text-primary">/reply</code> or click Manage.
                      </p>
                    )}
                  </div>
                )}

                {/* Active Macro Actions Strip */}
                {activeMacro && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="font-semibold text-primary">
                      Macro ({activeMacro.templateName}):
                    </span>
                    {activeMacro.macroStatus && (
                      <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary capitalize">
                        Status → {activeMacro.macroStatus.replaceAll("_", " ")}
                      </span>
                    )}
                    {activeMacro.macroPriority && (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300 capitalize">
                        Priority → {activeMacro.macroPriority}
                      </span>
                    )}
                    {activeMacro.macroTags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-700 dark:text-amber-300"
                      >
                        +{tag}
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setActiveMacro(null)}
                      className="text-muted-foreground hover:text-foreground underline ml-1 cursor-pointer"
                    >
                      Clear macro
                    </button>
                  </div>
                )}

                {/* Pending Attachment Previews */}
                {pendingAttachments.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {pendingAttachments.map((file, idx) => {
                      const isImg = file.mimeType.startsWith("image/") && !file.mimeType.includes("svg");
                      return (
                        <span
                          key={`${file.name}-${idx}`}
                          className="inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-accent/60 px-2.5 py-1.5 text-xs font-medium text-accent-foreground"
                        >
                          {isImg ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={`data:${file.mimeType};base64,${file.dataBase64}`}
                              alt={file.name}
                              className="size-7 rounded-md object-cover border border-border shrink-0"
                            />
                          ) : (
                            <Paperclip size={12} className="text-primary shrink-0" />
                          )}
                          <span className="max-w-[160px] truncate">{file.name}</span>
                          <span className="text-[10px] text-muted-foreground">
                            ({formatBytes(file.size)})
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() =>
                              setPendingAttachments((curr) => curr.filter((_, i) => i !== idx))
                            }
                            className="ml-0.5 rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Chat Dialogue Box (+ Left, Send Icon Right) */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void handleAttachmentSelect(e)}
                />

                <div className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                  <button
                    type="button"
                    aria-label="Attach files"
                    title="Attach file (max 4 MB per file)"
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent hover:text-primary transition cursor-pointer disabled:opacity-50"
                  >
                    <Plus size={18} />
                  </button>

                  <button
                    type="button"
                    aria-label="Quick replies and macros"
                    title="Quick replies & macros (or type /reply)"
                    disabled={busy}
                    onClick={() => setQuickRepliesOpen((o) => !o)}
                    className={`flex size-9 shrink-0 items-center justify-center rounded-xl border transition cursor-pointer disabled:opacity-50 ${
                      quickRepliesOpen
                        ? "border-primary bg-accent text-primary"
                        : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-accent hover:text-primary"
                    }`}
                  >
                    <Zap size={16} />
                  </button>

                  <textarea
                    aria-label="Customer reply"
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setSlashIndex(0);
                    }}
                    onKeyDown={(e) => {
                      if (slashQuery !== null && slashTemplates.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSlashIndex((i) => (i + 1) % slashTemplates.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSlashIndex(
                            (i) => (i - 1 + slashTemplates.length) % slashTemplates.length,
                          );
                          return;
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          const chosen =
                            slashTemplates[Math.min(slashIndex, slashTemplates.length - 1)];
                          if (chosen) selectSlashTemplate(chosen);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setBody((curr) => curr.replace(/(?:^|\s)\/[a-z0-9_-]*$/i, ""));
                          return;
                        }
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void send(false);
                      }
                    }}
                    rows={2}
                    placeholder={
                      ticket.channel === "instagram"
                        ? `Message ${ticket.external_username || ticket.customer_email} on Instagram (type /reply for macros)…`
                        : ticket.channel === "facebook"
                          ? `Message ${ticket.customer_name || ticket.customer_email} on Facebook (type /reply for macros)…`
                          : `Reply by email to ${ticket.customer_email} (type /reply for macros)…`
                    }
                    className="flex-1 min-h-[42px] max-h-40 border-0 bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none resize-y"
                  />

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="secondary"
                      size="sm"
                      title="Send reply and resolve ticket"
                      disabled={busy || (!body.trim() && pendingAttachments.length === 0)}
                      onClick={() => void send(true)}
                      className="h-9 px-2.5 text-xs hidden sm:inline-flex"
                    >
                      <CheckCircle2 size={14} /> Resolve
                    </Button>
                    <button
                      type="button"
                      aria-label="Send reply"
                      title="Send reply (Cmd/Ctrl + Enter)"
                      disabled={busy || (!body.trim() && pendingAttachments.length === 0)}
                      onClick={() => void send(false)}
                      className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs hover:opacity-95 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </div>
              </footer>
            </section>

            {/* RIGHT PANEL: NOTES & CUSTOMER 360 + LINK ORDER */}
            {detailsSidebarOpen && (
            <CustomerProfileSidebar
              visibleOnMobile={notesPanelOpen}
              ticket={ticket}
              internalNotes={internalNotes}
              noteBody={noteBody}
              onNoteBodyChange={setNoteBody}
              onSendNote={() => void sendNote()}
              noteInputRef={noteInputRef}
              activeCustomer={activeCustomer}
              customer360={data.customer360 || computeCustomer360([], 0)}
              linkedCustomer={
                data.linkedCustomer || {
                  isLinked: false,
                  linkedOrderId: null,
                  linkedEmail: "",
                  linkedPhone: "",
                  linkedName: "",
                }
              }
              orders={data.orders || []}
              events={(data.events as Event[]) || []}
              busy={busy}
              priorityBadgeClass={getPriorityBadgeStyle(ticket.priority)}
              formatShortDate={formatShortDate}
              visibleBody={visibleEmailBody}
              onLinkCustomer={async (hit) => {
                await act("link_customer", {
                  orderId: hit.id,
                  customerEmail: hit.customer_email,
                  customerPhone: hit.customer_phone,
                  customerName: hit.customer_name,
                });
              }}
              onUnlinkCustomer={async () => {
                await act("unlink_customer");
              }}
              onTrackOrder={(target) => setTrackingTarget(target)}
            />
            )}
          </div>
        </div>
      )}

      </div>

      <OrderTrackingModal
        target={trackingTarget}
        onClose={() => setTrackingTarget(null)}
      />

      <DeclineReplyModal
        key={declineTarget?.id || "closed"}
        ticket={declineTarget}
        busy={busy}
        onClose={() => setDeclineTarget(null)}
        onSubmit={async (payload) => {
          const ok = await act(
            "ai_decline_reply",
            {
              customerQuery: payload.customerQuery,
              proposedReply: payload.proposedReply,
              declineReason: payload.declineReason,
              correctedReply: payload.correctedReply,
              requestKey: crypto.randomUUID(),
            },
            payload.ticketId,
            payload.version,
          );
          if (ok) setDeclineTarget(null);
        }}
      />

      <SupportModals
        lightboxImage={lightboxImage}
        onCloseLightbox={() => setLightboxImage(null)}
        newTicketOpen={newTicketOpen}
        onCloseNewTicket={() => setNewTicketOpen(false)}
        ticketSingular={ticketSingular}
        newEmail={newEmail}
        onNewEmailChange={setNewEmail}
        newSubject={newSubject}
        onNewSubjectChange={setNewSubject}
        newQuery={newQuery}
        onNewQueryChange={setNewQuery}
        onSubmitQuickTicket={submitQuickTicket}
        templatesOpen={templatesOpen}
        onCloseTemplates={() => {
          setTemplatesOpen(false);
          setTemplateDraft(null);
        }}
        templatesList={templatesList}
        templateDraft={templateDraft}
        onTemplateDraftChange={setTemplateDraft}
        onAct={(action, b) => act(action, b)}
        busy={busy}
      />
    </div>
  );
}
