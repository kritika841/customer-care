"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Sparkles,
  Database,
  ShieldCheck,
  RefreshCw,
  Plus,
  Trash2,
  Search,
  BookOpen,
  BrainCircuit,
  AlertTriangle,
  CheckCircle2,
  ArrowUpRight,
  Sliders,
  Play,
  Clock,
  Send,
  MessageSquare,
} from "lucide-react";
import { Button } from "./ui/button";
import { readJson, requestErrorMessage } from "../lib/http";
import { cleanTicketPreviewText } from "../lib/support-ui";

type KnowledgeDoc = {
  id: string;
  title: string;
  category: "policy" | "product" | "faq" | "admin_memory" | "template";
  source_ref: string;
  content: string;
  chunk_count: number;
  is_active: boolean;
  created_by: string;
  updated_at: string;
};

type PendingEscalation = {
  id: string;
  ticket_id: string;
  ticket_number: number;
  subject: string;
  customer_name: string;
  customer_email: string;
  channel: string;
  external_username: string;
  escalation_type: "missing_context" | "human_action_required";
  action_category: string;
  ai_question_for_admin: string;
  customer_query_excerpt: string;
  created_at: string;
};

type AiTimelineItem = {
  ticket_id: string;
  ticket_number: number;
  subject: string;
  customer_name: string;
  customer_email: string;
  channel: string;
  external_username: string;
  ai_status: string;
  ai_confidence: number | string | null;
  customer_query: string;
  ai_reply_body: string;
  ai_reply_at: string | null;
  ai_delivery_status: string;
  ai_question_for_admin: string;
  escalation_type: string;
  action_category: string;
  escalation_status: string;
  activity_at: string;
};

type AiSettingsClient = {
  operatingMode: "off" | "draft_only" | "allowlist_only" | "live_auto";
  approvalModeEnabled?: boolean;
  liveOutboundEnabled: boolean;
  testRecipientAllowlist: string[];
  compactionTokenThreshold: number;
  autoReplyConfidenceThreshold: number;
  vipOrderValueThreshold: number;
  debounceSeconds: number;
  humanActionPolicies: string[];
  brandPersonaPrompt: string;
  providerInfo?: {
    provider: string;
    chatModel: string;
    embeddingModel: string;
    apiKeyConfigured: boolean;
  };
};

type SimulationResult = {
  query: string;
  channel: string;
  provider: string;
  model: string;
  decision: {
    decision: "auto_reply" | "ask_admin_context" | "human_action_required";
    confidence: number;
    reasoning: string;
    customerReplyDraft: string;
    shouldResolveTicket: boolean;
    suggestedPriority: string;
    suggestedTags: string[];
    questionForAdmin: string;
    humanActionCategory: string;
    humanActionSummary: string;
    citedDocumentTitles: string[];
  };
  storeContext: {
    orders: Array<{
      id: number;
      channelOrderId: string;
      status: string;
      awb: string;
      courier: string;
      total: number;
      isVipHighValue: boolean;
      itemsSummary: string;
    }>;
    hasVipOrder: boolean;
    highestOrderTotal: number;
    ragChunks: Array<{
      chunkId: string;
      documentId: string;
      documentTitle: string;
      category: string;
      heading: string;
      content: string;
      rrfScore: number;
      vectorSimilarity: number;
      lexicalScore: number;
    }>;
    embeddingModel: string;
  };
};

function formatExactTimestamp(iso?: string | null) {
  if (!iso) return "Just now";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Just now";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getChannelPill(channel?: string) {
  switch (channel) {
    case "instagram":
      return {
        label: "Instagram",
        cls: "bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30",
      };
    case "facebook":
      return {
        label: "Facebook",
        cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
      };
    default:
      return {
        label: "Email",
        cls: "bg-primary/15 text-primary border-primary/30",
      };
  }
}

export default function SupportAiKnowledgeView({
  onOpenTicket,
  onRefreshDashboard,
  knowledgeSummary,
}: {
  onOpenTicket: (ticketId: string) => void;
  onRefreshDashboard: () => void;
  knowledgeSummary?: {
    totalDocuments: number;
    totalChunks: number;
    policyCount: number;
    productCount: number;
    faqCount: number;
    adminMemoryCount: number;
    templateCount: number;
  };
}) {
  const [subTab, setSubTab] = useState<
    "timeline" | "needs_input" | "knowledge" | "simulator"
  >("timeline");
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [pendingEscalations, setPendingEscalations] = useState<PendingEscalation[]>([]);
  const [aiTimeline, setAiTimeline] = useState<AiTimelineItem[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");

  // Inline Quick-Answer State keyed by ticket_id
  const [inlineAnswers, setInlineAnswers] = useState<Record<string, string>>({});
  const [inlineSaveMemory, setInlineSaveMemory] = useState<Record<string, boolean>>({});

  // Document Editor State
  const [editingDoc, setEditingDoc] = useState<{
    id?: string;
    title: string;
    category: "policy" | "product" | "faq" | "admin_memory" | "template";
    content: string;
  } | null>(null);

  // Interactive RAG + AI Agent Simulator State
  const [simQuery, setSimQuery] = useState<string>(
    "Hi, what is your size exchange policy and how many days do I have after delivery?"
  );
  const [simChannel, setSimChannel] = useState<string>("instagram");
  const [simEmail, setSimEmail] = useState<string>("");
  const [simRunning, setSimRunning] = useState<boolean>(false);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  // Claude-Style Self-Updating Memory Assistant State
  const [memoryCommand, setMemoryCommand] = useState<string>("");
  const [memoryChatBusy, setMemoryChatBusy] = useState<boolean>(false);
  const [memoryHistory, setMemoryHistory] = useState<
    Array<{
      instruction: string;
      reply: string;
      operations: Array<{ op: string; summary: string }>;
    }>
  >([]);

  // Settings Drawer State
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [loadedSettings, setLoadedSettings] = useState<AiSettingsClient | null>(null);
  const [compactionThreshold, setCompactionThreshold] = useState<number>(10000);
  const [vipThreshold, setVipThreshold] = useState<number>(3000);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(82);
  const [debounceSeconds, setDebounceSeconds] = useState<number>(30);
  const [humanPoliciesText, setHumanPoliciesText] = useState<string>(
    "callback_requested, damaged_or_wrong_item, refund_or_cancellation, manual_order_modification, payment_dispute, vip_high_value_order, angry_customer_escalation"
  );
  const [personaPrompt, setPersonaPrompt] = useState<string>("");

  const loadKnowledge = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        mode: "knowledge",
        category: categoryFilter,
        q: searchQuery.trim(),
      });
      const res = await readJson<{
        documents: KnowledgeDoc[];
        aiSettings: AiSettingsClient;
        pendingEscalations: PendingEscalation[];
        aiTimeline?: AiTimelineItem[];
      }>(await fetch(`/api/support?${params.toString()}`, { cache: "no-store" }));
      setDocs(res.documents || []);
      setPendingEscalations(res.pendingEscalations || []);
      setAiTimeline(res.aiTimeline || []);
      if (res.aiSettings) {
        setLoadedSettings(res.aiSettings);
        setCompactionThreshold(res.aiSettings.compactionTokenThreshold || 10000);
        setVipThreshold(res.aiSettings.vipOrderValueThreshold || 3000);
        setConfidenceThreshold(
          Math.round((res.aiSettings.autoReplyConfidenceThreshold || 0.82) * 100)
        );
        setDebounceSeconds(Number(res.aiSettings.debounceSeconds ?? 30));
        if (Array.isArray(res.aiSettings.humanActionPolicies)) {
          setHumanPoliciesText(res.aiSettings.humanActionPolicies.join(", "));
        }
        setPersonaPrompt(res.aiSettings.brandPersonaPrompt || "");
      }
    } catch (e) {
      setError(requestErrorMessage(e, "Failed to load AI Timeline & Knowledge Base"));
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, searchQuery]);

  useEffect(() => {
    const timer = setTimeout(() => void loadKnowledge(), 0);
    return () => clearTimeout(timer);
  }, [loadKnowledge]);

  async function postAiAction(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await readJson<Record<string, unknown>>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
      if (typeof res.notice === "string" && res.notice) {
        setNotice(res.notice);
      }
      await loadKnowledge();
      onRefreshDashboard();
      return res;
    } catch (e) {
      setError(requestErrorMessage(e, "AI operation failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitInlineAdminAnswer(
    ticketId: string,
    escalationId?: string
  ) {
    const raw = (inlineAnswers[ticketId] || "").trim();
    if (!raw) return;
    const saveMem = inlineSaveMemory[ticketId] ?? true;
    const res = await postAiAction({
      action: "ai_resolve_escalation",
      ticketId,
      escalationId,
      adminRawAnswer: raw,
      saveToMemory: saveMem,
      resolveTicket: true,
    });
    if (res?.ok) {
      setInlineAnswers((prev) => ({ ...prev, [ticketId]: "" }));
    }
  }

  async function handleMemoryCommand(e: React.FormEvent) {
    e.preventDefault();
    const text = memoryCommand.trim();
    if (!text) return;
    setMemoryChatBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await readJson<{
        assistantReply: string;
        operations: Array<{ op: string; summary: string }>;
      }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ai_memory_command",
            instruction: text,
          }),
        }),
      );
      setMemoryHistory((prev) => [
        {
          instruction: text,
          reply: res.assistantReply,
          operations: res.operations || [],
        },
        ...prev.slice(0, 9),
      ]);
      setMemoryCommand("");
      await loadKnowledge();
      onRefreshDashboard();
    } catch (err) {
      setError(requestErrorMessage(err, "Failed to update AI memory"));
    } finally {
      setMemoryChatBusy(false);
    }
  }

  async function runSimulation(e: React.FormEvent) {
    e.preventDefault();
    if (!simQuery.trim()) return;
    setSimRunning(true);
    setError("");
    try {
      const res = await readJson<{ simulation: SimulationResult }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ai_simulate",
            query: simQuery.trim(),
            channel: simChannel,
            customerEmail: simEmail.trim() || undefined,
          }),
        })
      );
      setSimResult(res.simulation);
    } catch (err) {
      setError(requestErrorMessage(err, "Simulation failed"));
    } finally {
      setSimRunning(false);
    }
  }

  const categoryBadge = (cat: string) => {
    switch (cat) {
      case "admin_memory":
        return "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30";
      case "policy":
        return "bg-primary/15 text-primary border-primary/30";
      case "product":
        return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
      case "template":
        return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  const answeredCount = aiTimeline.filter((t) => Boolean(t.ai_reply_body)).length;

  return (
    <div className="space-y-4">
      {/* COMPACT TOP COMMAND BAR */}
      <div className="panel p-3.5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/35 bg-success/15 px-3 py-1 text-xs font-bold text-success">
              <ShieldCheck size={13} />
              {loadedSettings?.approvalModeEnabled === false
                ? `Auto-Send (≥${Math.round((loadedSettings?.autoReplyConfidenceThreshold ?? 0.82) * 100)}%)`
                : "Approval Mode ON"}
            </span>
            <span className="text-xs text-muted-foreground">
              <strong className="text-foreground">{answeredCount}</strong> AI Responses ·{" "}
              <strong className="text-purple-600 dark:text-purple-400">
                {knowledgeSummary?.adminMemoryCount ??
                  docs.filter((d) => d.category === "admin_memory").length}
              </strong>{" "}
              Memories
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setSettingsOpen((v) => !v)}
              className="h-8 px-2.5 text-xs"
            >
              <Sliders size={13} /> Guardrails
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void postAiAction({ action: "ai_knowledge_sync" })}
              className="h-8 px-3 text-xs"
            >
              <Database size={13} className={busy ? "spin" : ""} /> Sync Store RAG
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void postAiAction({ action: "ai_batch_triage" })}
              className="h-8 px-3 text-xs"
            >
              <Sparkles size={13} /> Auto-Answer Next 8
            </Button>
          </div>
        </div>

        {/* CLEAN 4-TAB SWITCHER (single line on desktop) */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/70">
            <button
              type="button"
              onClick={() => setSubTab("timeline")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                subTab === "timeline"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Clock size={13} />
              <span>AI Timeline</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono ${
                  subTab === "timeline"
                    ? "bg-white/20 text-primary-foreground"
                    : "bg-card text-foreground"
                }`}
              >
                {aiTimeline.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab("needs_input")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                subTab === "needs_input"
                  ? "bg-amber-500 text-white shadow-xs"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <AlertTriangle size={13} />
              <span>Needs Input</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono font-bold ${
                  subTab === "needs_input"
                    ? "bg-white/25 text-white"
                    : pendingEscalations.length > 0
                      ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                      : "bg-card text-muted-foreground"
                }`}
              >
                {pendingEscalations.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab("knowledge")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                subTab === "knowledge"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen size={13} />
              <span>Store Brain &amp; AI Memory</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono ${
                  subTab === "knowledge"
                    ? "bg-white/20 text-primary-foreground"
                    : "bg-card text-foreground"
                }`}
              >
                {knowledgeSummary?.totalDocuments ?? docs.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab("simulator")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                subTab === "simulator"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <BrainCircuit size={13} />
              <span>Test Simulator</span>
            </button>
        </div>

        {(error || notice) && (
          <div>
            {error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive flex items-center justify-between">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => setError("")}
                  className="underline font-semibold ml-3 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}
            {notice && (
              <div className="rounded-xl border border-success/30 bg-success/10 px-4 py-2 text-xs font-medium text-success flex items-center justify-between">
                <span>{notice}</span>
                <button
                  type="button"
                  onClick={() => setNotice("")}
                  className="underline font-semibold ml-3 cursor-pointer"
                >
                  OK
                </button>
              </div>
            )}
          </div>
        )}

        {/* Collapsible AI Guardrails Drawer */}
        {settingsOpen && (
          <form
            className="rounded-xl border border-border bg-muted/20 p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void postAiAction({
                action: "ai_settings_update",
                operatingMode: loadedSettings?.operatingMode || "draft_only",
                liveOutboundEnabled: Boolean(loadedSettings?.liveOutboundEnabled),
                compactionTokenThreshold: compactionThreshold,
                vipOrderValueThreshold: vipThreshold,
                autoReplyConfidenceThreshold: confidenceThreshold / 100,
                debounceSeconds,
                humanActionPolicies: humanPoliciesText
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                brandPersonaPrompt: personaPrompt,
              });
              setSettingsOpen(false);
            }}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                AI Guardrails, Compaction, Debounce &amp; Escalation Policies
              </h3>
              <span className="text-[11px] font-semibold text-success">
                Mode: {loadedSettings?.operatingMode || "draft_only"}
                {loadedSettings?.liveOutboundEnabled ? " · Live Send Enabled" : " · Draft Only"}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                <span>Compaction Token Threshold</span>
                <input
                  type="number"
                  min={1000}
                  max={100000}
                  step={500}
                  value={compactionThreshold}
                  onChange={(e) => setCompactionThreshold(Number(e.target.value))}
                  className="h-8 rounded-lg border border-input bg-background px-3 text-xs text-foreground"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                <span>VIP Order Value Escalation (₹)</span>
                <input
                  type="number"
                  min={500}
                  max={50000}
                  step={100}
                  value={vipThreshold}
                  onChange={(e) => setVipThreshold(Number(e.target.value))}
                  className="h-8 rounded-lg border border-input bg-background px-3 text-xs text-foreground"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                <span>Auto-Reply Confidence Gate (%)</span>
                <input
                  type="number"
                  min={50}
                  max={99}
                  value={confidenceThreshold}
                  onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                  className="h-8 rounded-lg border border-input bg-background px-3 text-xs text-foreground"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                <span>Message Debounce (sec)</span>
                <input
                  type="number"
                  min={0}
                  max={300}
                  step={5}
                  value={debounceSeconds}
                  onChange={(e) => setDebounceSeconds(Number(e.target.value))}
                  className="h-8 rounded-lg border border-input bg-background px-3 text-xs text-foreground"
                />
              </label>
            </div>
            <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
              <span>Mandatory Human Escalation Policies (comma-separated slugs)</span>
              <input
                type="text"
                value={humanPoliciesText}
                onChange={(e) => setHumanPoliciesText(e.target.value)}
                className="h-8 rounded-lg border border-input bg-background px-3 text-xs text-foreground font-mono"
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
              <span>Satmi AI Brand Persona &amp; Grounding Instructions</span>
              <textarea
                rows={2}
                value={personaPrompt}
                onChange={(e) => setPersonaPrompt(e.target.value)}
                className="rounded-lg border border-input bg-background p-2.5 text-xs text-foreground"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSettingsOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Save Guardrails
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* TAB 1: CHRONOLOGICAL AI ANSWERS TIMELINE ("WHAT THE AI HAS ANSWERED AT A CERTAIN POINT OF TIME") */}
      {subTab === "timeline" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div>
              <h2 className="text-sm font-bold text-foreground">
                Chronological AI Answers &amp; Decision Log
              </h2>
              <p className="text-xs text-muted-foreground">
                Every customer query processed by the AI, showing the exact timestamp, what the customer asked, and what the AI answered or escalated.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={loading || busy}
              onClick={() => void loadKnowledge()}
              className="h-8 px-3 text-xs"
            >
              <RefreshCw size={12} className={loading ? "spin" : ""} /> Refresh Timeline
            </Button>
          </div>

          {loading ? (
            <div className="panel py-16 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw size={15} className="spin" /> Loading AI Answers Timeline...
            </div>
          ) : aiTimeline.length === 0 ? (
            <div className="panel py-16 px-6 text-center space-y-3">
              <Sparkles size={26} className="mx-auto text-primary opacity-60" />
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-foreground">
                  No tickets have been processed by the AI yet
                </h3>
                <p className="text-xs text-muted-foreground max-w-md mx-auto">
                  Click <strong>Auto-Answer Next 8 Tickets</strong> above to run Gemini 2.5 Flash across your open inbox queries in Safe Draft Mode.
                </p>
              </div>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void postAiAction({ action: "ai_batch_triage" })}
              >
                <Sparkles size={13} /> Auto-Answer Next 8 Tickets Now
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {aiTimeline.map((item) => {
                const ch = getChannelPill(item.channel);
                const hasReply = Boolean(item.ai_reply_body);
                const isHumanEscalation =
                  item.ai_status === "needs_human_action" ||
                  item.escalation_type === "human_action_required";
                const needsAdminContext =
                  item.ai_status === "needs_admin_input" ||
                  (item.escalation_type === "missing_context" &&
                    item.escalation_status === "pending");

                return (
                  <div
                    key={item.ticket_id}
                    className="panel p-4 space-y-3 hover:border-primary/40 transition"
                  >
                    {/* Header: Exact Timestamp + Channel + Customer + Confidence + Open Button */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-border/60">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] font-semibold text-foreground">
                          <Clock size={11} className="text-primary" />
                          {formatExactTimestamp(item.ai_reply_at || item.activity_at)}
                        </span>

                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${ch.cls}`}
                        >
                          {ch.label}
                        </span>

                        <strong className="text-xs font-bold text-foreground">
                          {item.customer_name || item.external_username || item.customer_email}
                        </strong>

                        <span className="font-mono text-[11px] text-muted-foreground">
                          #{String(item.ticket_number).padStart(4, "0")}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {item.ai_confidence != null && (
                          <span className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            Confidence: {Math.round(Number(item.ai_confidence) * 100)}%
                          </span>
                        )}

                        {hasReply && !isHumanEscalation && !needsAdminContext && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-success/35 bg-success/15 px-2.5 py-0.5 text-[11px] font-bold text-success">
                            <CheckCircle2 size={11} /> AI Answered (Safe Draft)
                          </span>
                        )}

                        {needsAdminContext && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-bold text-amber-800 dark:text-amber-300">
                            <AlertTriangle size={11} /> AI Asked Admin for Context
                          </span>
                        )}

                        {isHumanEscalation && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/35 bg-destructive/15 px-2.5 py-0.5 text-[11px] font-bold text-destructive">
                            <AlertTriangle size={11} /> Human Action:{" "}
                            {(item.action_category || "Escalated").replaceAll("_", " ")}
                          </span>
                        )}

                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-[11px]"
                          onClick={() => onOpenTicket(item.ticket_id)}
                        >
                          Open Thread <ArrowUpRight size={12} />
                        </Button>
                      </div>
                    </div>

                    {/* Side-by-Side: What Customer Asked vs. What AI Answered at that Point in Time */}
                    <div className="grid grid-cols-1 lg:grid-cols-[0.42fr_0.58fr] gap-3">
                      {/* Left: Customer Query */}
                      <div className="rounded-xl border border-border bg-muted/25 p-3 space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare size={11} /> Customer Asked
                          </span>
                          <span>{item.subject}</span>
                        </div>
                        <p className="text-xs text-foreground line-clamp-3 leading-relaxed">
                          {cleanTicketPreviewText(item.customer_query || "", item.subject)}
                        </p>
                      </div>

                      {/* Right: What AI Answered / Asked Admin */}
                      <div className="space-y-2">
                        {hasReply && (
                          <div className="rounded-xl border border-success/30 bg-success/5 p-3 space-y-1.5">
                            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-success">
                              <span className="inline-flex items-center gap-1">
                                <Sparkles size={11} /> What AI Answered at{" "}
                                {formatExactTimestamp(item.ai_reply_at || item.activity_at)}
                              </span>
                              <span>
                                {item.ai_delivery_status === "sent"
                                  ? "Sent to Customer"
                                  : "Staged in Safe Mode"}
                              </span>
                            </div>
                            <p className="text-xs text-foreground whitespace-pre-line leading-relaxed">
                              {item.ai_reply_body}
                            </p>
                          </div>
                        )}

                        {item.ai_question_for_admin && (
                          <div
                            className={`rounded-xl border p-3 space-y-2.5 ${
                              isHumanEscalation
                                ? "border-destructive/30 bg-destructive/5"
                                : "border-amber-500/35 bg-amber-500/10"
                            }`}
                          >
                            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                              <span>
                                {isHumanEscalation
                                  ? `Why AI Escalated for Human Action (${item.action_category.replaceAll("_", " ")}):`
                                  : `What AI Asked Admin at ${formatExactTimestamp(item.activity_at)}:`}
                              </span>
                              <span>Status: {item.escalation_status || "pending"}</span>
                            </div>
                            <p className="text-xs font-medium text-foreground">
                              {item.ai_question_for_admin}
                            </p>

                            {/* Inline 1-Step Answer Box so Admin Can Answer Without Leaving the Timeline */}
                            {item.escalation_status === "pending" && (
                              <div className="pt-1 space-y-2">
                                <div className="flex flex-col sm:flex-row gap-2">
                                  <input
                                    type="text"
                                    value={inlineAnswers[item.ticket_id] || ""}
                                    onChange={(e) =>
                                      setInlineAnswers((prev) => ({
                                        ...prev,
                                        [item.ticket_id]: e.target.value,
                                      }))
                                    }
                                    placeholder="Type your answer here — AI will rephrase it for the customer..."
                                    className="h-8 flex-1 rounded-lg border border-input bg-background px-3 text-xs text-foreground outline-none focus:border-ring"
                                  />
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    disabled={busy || !(inlineAnswers[item.ticket_id] || "").trim()}
                                    onClick={() => void submitInlineAdminAnswer(item.ticket_id)}
                                    className="h-8 px-3 text-xs shrink-0"
                                  >
                                    <Send size={12} /> AI Rephrase &amp; Answer
                                  </Button>
                                </div>
                                <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={inlineSaveMemory[item.ticket_id] ?? true}
                                    onChange={(e) =>
                                      setInlineSaveMemory((prev) => ({
                                        ...prev,
                                        [item.ticket_id]: e.target.checked,
                                      }))
                                    }
                                    className="size-3.5 rounded border-input accent-primary"
                                  />
                                  <span>
                                    Save generalized answer to <strong>AI Memory</strong> for future questions
                                  </span>
                                </label>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: NEEDS YOUR ANSWER (DEDICATED EXCEPTION QUEUE) */}
      {subTab === "needs_input" && (
        <div className="space-y-3">
          <div className="px-1">
            <h2 className="text-sm font-bold text-foreground">
              Questions Where AI Needs Your Context or Human Action ({pendingEscalations.length})
            </h2>
            <p className="text-xs text-muted-foreground">
              Answer in plain shorthand below. The AI will automatically rephrase your answer to the customer and—if checked—save it to AI Memory so it never has to ask again.
            </p>
          </div>

          {pendingEscalations.length === 0 ? (
            <div className="panel py-16 text-center space-y-2">
              <CheckCircle2 size={26} className="mx-auto text-success" />
              <h3 className="text-sm font-bold text-foreground">
                Zero pending questions from the AI!
              </h3>
              <p className="text-xs text-muted-foreground">
                The AI has all the context it needs for current triaged tickets.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {pendingEscalations.map((esc) => {
                const ch = getChannelPill(esc.channel);
                return (
                  <div
                    key={esc.id}
                    className="panel p-4 border-l-4 border-l-amber-500 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            esc.escalation_type === "human_action_required"
                              ? "bg-destructive/15 text-destructive border-destructive/30"
                              : "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30"
                          }`}
                        >
                          {esc.escalation_type === "human_action_required"
                            ? `Human Action · ${esc.action_category.replaceAll("_", " ")}`
                            : "Missing Store Context"}
                        </span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${ch.cls}`}
                        >
                          {ch.label}
                        </span>
                        <strong className="text-xs font-bold text-foreground">
                          {esc.customer_name || esc.external_username || esc.customer_email}
                        </strong>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          #{String(esc.ticket_number || "").padStart(4, "0")} · Asked{" "}
                          {formatExactTimestamp(esc.created_at)}
                        </span>
                      </div>

                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => onOpenTicket(esc.ticket_id)}
                      >
                        Open Full Thread <ArrowUpRight size={12} />
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-xl border border-border bg-muted/25 p-3 text-xs space-y-1">
                        <strong className="text-[10px] uppercase tracking-wider text-muted-foreground block">
                          Customer Message:
                        </strong>
                        <p className="text-foreground whitespace-pre-line">
                          {esc.customer_query_excerpt || esc.subject}
                        </p>
                      </div>
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-1">
                        <strong className="text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-300 block">
                          AI Question to You:
                        </strong>
                        <p className="font-medium text-foreground">
                          {esc.ai_question_for_admin}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={inlineAnswers[esc.ticket_id] || ""}
                        onChange={(e) =>
                          setInlineAnswers((prev) => ({
                            ...prev,
                            [esc.ticket_id]: e.target.value,
                          }))
                        }
                        placeholder="Type the answer in plain words (e.g. '699 pack has 120 dhoop sticks + ceramic stand')..."
                        className="h-9 flex-1 rounded-xl border border-input bg-background px-3 text-xs text-foreground outline-none focus:border-ring"
                      />
                      <label className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground cursor-pointer select-none px-2">
                        <input
                          type="checkbox"
                          checked={inlineSaveMemory[esc.ticket_id] ?? true}
                          onChange={(e) =>
                            setInlineSaveMemory((prev) => ({
                              ...prev,
                              [esc.ticket_id]: e.target.checked,
                            }))
                          }
                          className="size-4 rounded border-input accent-primary"
                        />
                        <span>Save to AI Memory</span>
                      </label>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy || !(inlineAnswers[esc.ticket_id] || "").trim()}
                        onClick={() => void submitInlineAdminAnswer(esc.ticket_id, esc.id)}
                        className="h-9 px-4 text-xs shrink-0"
                      >
                        <Sparkles size={13} /> AI Rephrase &amp; Resolve
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: CLAUDE-STYLE SELF-UPDATING AI MEMORY + STORE KNOWLEDGE BASE */}
      {subTab === "knowledge" && (
        <div className="space-y-4">
          {/* Claude-Style Conversational AI Memory Updater */}
          <div className="panel p-5 space-y-3 border-purple-500/30 bg-gradient-to-r from-purple-500/5 via-card to-primary/5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-xl bg-purple-500/15 text-purple-600 dark:text-purple-400">
                  <BrainCircuit size={17} />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-foreground">
                    Talk to AI to Update Its Memory
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Tell the AI what to remember, update, or forget (like Claude’s Memory Tool) — it inspects its existing memories and updates them automatically.
                  </p>
                </div>
              </div>
            </div>

            <form onSubmit={handleMemoryCommand} className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={memoryCommand}
                onChange={(e) => setMemoryCommand(e.target.value)}
                disabled={memoryChatBusy}
                placeholder="e.g. 'Remember that prepaid orders above ₹1,500 ship free' or 'Update exchange window from 7 to 14 days' or 'Forget Diwali offer'..."
                className="h-9 flex-1 rounded-xl border border-input bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={memoryChatBusy || !memoryCommand.trim()}
                className="h-9 px-4 text-xs shrink-0"
              >
                <Sparkles size={13} /> {memoryChatBusy ? "Updating Memory…" : "Tell AI to Update Memory"}
              </Button>
            </form>

            {memoryHistory.length > 0 && (
              <div className="space-y-2 pt-1 max-h-60 overflow-y-auto">
                {memoryHistory.map((entry, idx) => (
                  <div
                    key={idx}
                    className="rounded-xl border border-border bg-card p-3 text-xs space-y-1.5"
                  >
                    <p className="font-semibold text-foreground">You: {entry.instruction}</p>
                    <p className="text-muted-foreground">{entry.reply}</p>
                    {entry.operations.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {entry.operations.map((op, opIdx) => (
                          <span
                            key={opIdx}
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              op.op === "delete"
                                ? "border-destructive/35 bg-destructive/10 text-destructive"
                                : op.op === "update"
                                  ? "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                                  : op.op === "create"
                                    ? "border-success/35 bg-success/10 text-success"
                                    : "border-border bg-muted text-muted-foreground"
                            }`}
                          >
                            {op.op.toUpperCase()}: {op.summary}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-foreground">
                Store RAG Knowledge Base &amp; Learned Admin Memory ({docs.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                All store policies, product specs, templates, and answers learned when you checked &ldquo;Save to AI Memory&rdquo;.
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() =>
                setEditingDoc({
                  title: "",
                  category: "policy",
                  content: "",
                })
              }
            >
              <Plus size={13} /> Add Store Knowledge
            </Button>
          </div>

          {editingDoc && (
            <form
              className="rounded-2xl border border-primary/30 bg-primary/5 p-4 space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!editingDoc.title.trim() || !editingDoc.content.trim()) return;
                const res = await postAiAction({
                  action: "ai_knowledge_upsert",
                  documentId: editingDoc.id,
                  title: editingDoc.title,
                  category: editingDoc.category,
                  content: editingDoc.content,
                });
                if (res?.ok) setEditingDoc(null);
              }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-2.5">
                <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                  <span>Document Title</span>
                  <input
                    type="text"
                    required
                    value={editingDoc.title}
                    onChange={(e) =>
                      setEditingDoc({ ...editingDoc, title: e.target.value })
                    }
                    placeholder="e.g. Satmi Dhoop Pack Stick Counts & Pricing"
                    className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground"
                  />
                </label>
                <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                  <span>Category</span>
                  <select
                    value={editingDoc.category}
                    onChange={(e) =>
                      setEditingDoc({
                        ...editingDoc,
                        category: e.target.value as KnowledgeDoc["category"],
                      })
                    }
                    className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground"
                  >
                    <option value="policy">Store Policy</option>
                    <option value="product">Product &amp; SKU Info</option>
                    <option value="faq">Store FAQ</option>
                    <option value="admin_memory">Learned Admin Memory</option>
                    <option value="template">Reply Template</option>
                  </select>
                </label>
              </div>
              <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                <span>Verified Store Facts / Policy Content</span>
                <textarea
                  rows={5}
                  required
                  value={editingDoc.content}
                  onChange={(e) =>
                    setEditingDoc({ ...editingDoc, content: e.target.value })
                  }
                  placeholder="Write verified store facts, product details, or policy rules..."
                  className="rounded-xl border border-input bg-background p-2.5 text-xs text-foreground"
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingDoc(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={busy}>
                  Chunk, Embed &amp; Save to RAG
                </Button>
              </div>
            </form>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {[
                { id: "all", label: "All" },
                { id: "admin_memory", label: "Learned Memory" },
                { id: "policy", label: "Policies" },
                { id: "product", label: "Products" },
                { id: "faq", label: "FAQs" },
                { id: "template", label: "Templates" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setCategoryFilter(tab.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                    categoryFilter === tab.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="relative flex items-center min-w-[220px]">
              <Search size={13} className="absolute left-2.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search knowledge base..."
                className="h-8 w-full rounded-full border border-input bg-background pl-8 pr-3 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="rounded-xl border border-border bg-card p-3.5 space-y-2 hover:border-primary/40 transition"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${categoryBadge(
                          doc.category
                        )}`}
                      >
                        {doc.category.replaceAll("_", " ")}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"} · Updated{" "}
                        {formatExactTimestamp(doc.updated_at)}
                      </span>
                    </div>
                    <h4 className="text-xs font-bold text-foreground truncate">
                      {doc.title}
                    </h4>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setEditingDoc({
                          id: doc.id,
                          title: doc.title,
                          category: doc.category,
                          content: doc.content,
                        })
                      }
                      className="rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:border-primary cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${doc.title}`}
                      onClick={() => {
                        if (confirm(`Remove "${doc.title}" from the RAG knowledge base?`)) {
                          void postAiAction({
                            action: "ai_knowledge_delete",
                            documentId: doc.id,
                          });
                        }
                      }}
                      className="flex size-7 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:text-destructive hover:border-destructive/40 cursor-pointer"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground whitespace-pre-line line-clamp-3 leading-relaxed">
                  {doc.content.replace(/^#+\s*/gm, "")}
                </p>
              </div>
            ))}
          </div>
          </div>
        </div>
      )}

      {/* TAB 4: TEST RAG SIMULATOR */}
      {subTab === "simulator" && (
        <div className="panel p-5 space-y-4 max-w-3xl">
          <div>
            <h3 className="text-sm font-bold text-foreground">
              Interactive Store RAG &amp; AI Decision Simulator
            </h3>
            <p className="text-xs text-muted-foreground">
              Test how Gemini 2.5 Flash + Hybrid RRF RAG answers or escalates any hypothetical customer question.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {[
              {
                label: "Size Exchange Policy",
                q: "Hi, what is your size exchange policy and how many days do I have after delivery?",
              },
              {
                label: "Callback Request (Human Escalation)",
                q: "Please arrange a callback on my number, I want to talk to an executive.",
              },
              {
                label: "Damaged Item Claim (Human Escalation)",
                q: "I received a damaged packet today. Please replace or refund.",
              },
              {
                label: "Unknown Product Detail (Asks Admin)",
                q: "Total sticks kitni hai 699 mai?",
              },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setSimQuery(preset.q)}
                className="rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-foreground hover:border-primary hover:text-primary transition cursor-pointer"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <form onSubmit={runSimulation} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                <span>Simulated Channel</span>
                <select
                  value={simChannel}
                  onChange={(e) => setSimChannel(e.target.value)}
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground"
                >
                  <option value="instagram">Instagram Direct DM</option>
                  <option value="facebook">Facebook Messenger</option>
                  <option value="email">Gmail / Support Email</option>
                </select>
              </label>
              <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                <span>Customer Email or Order Hint (Optional)</span>
                <input
                  type="text"
                  value={simEmail}
                  onChange={(e) => setSimEmail(e.target.value)}
                  placeholder="e.g. customer@example.com"
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground"
                />
              </label>
            </div>

            <textarea
              rows={3}
              value={simQuery}
              onChange={(e) => setSimQuery(e.target.value)}
              className="w-full rounded-xl border border-input bg-background p-3 text-xs text-foreground outline-none focus:border-ring"
            />

            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={simRunning || !simQuery.trim()}
              className="h-9 px-4 text-xs"
            >
              <Play size={13} /> {simRunning ? "Running RAG + AI..." : "Simulate RAG & AI Decision"}
            </Button>
          </form>

          {simResult && (
            <div className="rounded-2xl border border-border bg-muted/20 p-4 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-foreground">
                  Decision: {simResult.decision.decision} (Confidence:{" "}
                  {Math.round(simResult.decision.confidence * 100)}%)
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {simResult.provider} · {simResult.model}
                </span>
              </div>
              {simResult.decision.customerReplyDraft && (
                <div className="rounded-xl border border-success/30 bg-success/5 p-3">
                  <strong className="text-[10px] uppercase tracking-wider text-success block mb-1">
                    AI Reply Draft:
                  </strong>
                  <p className="whitespace-pre-line">{simResult.decision.customerReplyDraft}</p>
                </div>
              )}
              {simResult.decision.questionForAdmin && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                  <strong className="text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-300 block mb-1">
                    AI Question for Admin:
                  </strong>
                  <p>{simResult.decision.questionForAdmin}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
