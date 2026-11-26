"use client";

import { useState } from "react";
import {
  Sparkles,
  BrainCircuit,
  AlertTriangle,
  CheckCircle2,
  FileStack,
  Send,
  Database,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Coins,
} from "lucide-react";
import { Button } from "./ui/button";
import { readJson, requestErrorMessage } from "../lib/http";
import { formatCostInr, formatCostUsd, formatTokensCompact } from "../lib/support-ui";

export type AiEscalationItem = {
  id: string;
  ticket_id: string;
  escalation_type: "missing_context" | "human_action_required";
  action_category: string;
  ai_question_for_admin: string;
  customer_query_excerpt: string;
  status: "pending" | "answered" | "dismissed";
  admin_raw_answer?: string;
  ai_rephrased_reply?: string;
  saved_to_memory?: boolean;
  created_at: string;
};

export default function TicketAiAssistantCard({
  ticket,
  escalations,
  threadTokenEstimate,
  chatTokenTotals,
  chatTokenLogs = [],
  compactionThreshold = 10000,
  approvalModeEnabled = true,
  latestInboundText,
  onLoadIntoComposer,
  onRefreshTicket,
}: {
  ticket: {
    id: string;
    channel?: string;
    customer_name?: string;
    customer_email?: string;
    external_username?: string;
    subject?: string;
    ai_status?: string;
    ai_confidence?: number | string | null;
    ai_summary?: string;
    ai_summary_tokens?: number;
    ai_pinned_facts?: Record<string, unknown> | string | null;
  };
  escalations: AiEscalationItem[];
  threadTokenEstimate: number;
  chatTokenTotals?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    requestCount: number;
  };
  chatTokenLogs?: Array<{
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
  compactionThreshold?: number;
  approvalModeEnabled?: boolean;
  latestInboundText: string;
  onLoadIntoComposer: (rephrasedBody: string) => void;
  onRefreshTicket: () => Promise<void>;
}) {
  const pendingEscalation = escalations.find((e) => e.status === "pending") || null;

  const [adminPanelOpen, setAdminPanelOpen] = useState<boolean>(false);
  const [summaryOpen, setSummaryOpen] = useState<boolean>(false);
  const [tokenLogOpen, setTokenLogOpen] = useState<boolean>(false);
  const [adminRawAnswer, setAdminRawAnswer] = useState<string>("");
  const [saveToMemory, setSaveToMemory] = useState<boolean>(true);
  const [memoryPreview, setMemoryPreview] = useState<{
    canonicalMemoryTitle: string;
    canonicalQuestion: string;
    canonicalAnswer: string;
    customerReply: string;
  } | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [localNotice, setLocalNotice] = useState<string>("");
  const [localError, setLocalError] = useState<string>("");

  const pinnedFacts: {
    orderCodes?: string[];
    phones?: string[];
    awbNumbers?: string[];
    mentionedSizes?: string[];
  } = (() => {
    if (!ticket.ai_pinned_facts) return {};
    if (typeof ticket.ai_pinned_facts === "string") {
      try {
        return JSON.parse(ticket.ai_pinned_facts);
      } catch {
        return {};
      }
    }
    return ticket.ai_pinned_facts as Record<string, string[]>;
  })();

  const hasPinnedFacts =
    (pinnedFacts.orderCodes?.length || 0) > 0 ||
    (pinnedFacts.phones?.length || 0) > 0 ||
    (pinnedFacts.awbNumbers?.length || 0) > 0 ||
    (pinnedFacts.mentionedSizes?.length || 0) > 0;

  async function runAiOnTicket(forceCompact = false) {
    setBusy(true);
    setLocalError("");
    setLocalNotice("");
    try {
      const res = await readJson<{
        notice?: string;
        aiStatus?: string;
        decision?: {
          decision: string;
          customerReplyDraft?: string;
          questionForAdmin?: string;
        };
      }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ai_run_ticket",
            ticketId: ticket.id,
            forceCompact,
          }),
        })
      );
      if (res.notice) setLocalNotice(res.notice);
      if (
        res.decision?.decision === "ask_admin_context" ||
        res.decision?.decision === "human_action_required"
      ) {
        setAdminPanelOpen(true);
      }
      if (forceCompact) {
        setSummaryOpen(true);
      }
      await onRefreshTicket();
    } catch (e) {
      setLocalError(requestErrorMessage(e, "AI evaluation failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handlePreviewRephrase() {
    if (!adminRawAnswer.trim()) return;
    setBusy(true);
    setLocalError("");
    setLocalNotice("");
    try {
      const res = await readJson<{
        customerReply: string;
        canonicalMemoryTitle: string;
        canonicalQuestion: string;
        canonicalAnswer: string;
      }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ai_rephrase_preview",
            ticketId: ticket.id,
            escalationId: pendingEscalation?.id,
            customerName:
              ticket.customer_name || ticket.external_username || "Customer",
            channel: ticket.channel || "email",
            customerQuery:
              pendingEscalation?.customer_query_excerpt ||
              latestInboundText ||
              ticket.subject ||
              "",
            aiQuestionForAdmin: pendingEscalation?.ai_question_for_admin,
            adminRawAnswer: adminRawAnswer.trim(),
          }),
        })
      );
      setMemoryPreview(res);
      if (res.customerReply) {
        onLoadIntoComposer(res.customerReply);
        setLocalNotice(
          "AI rephrased your answer and loaded it into the reply box below. Review or click 'Commit Answer & Save to Memory'."
        );
      }
    } catch (e) {
      setLocalError(requestErrorMessage(e, "Could not rephrase answer"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCommitEscalationAnswer() {
    if (!adminRawAnswer.trim()) return;
    setBusy(true);
    setLocalError("");
    setLocalNotice("");
    try {
      const res = await readJson<{
        rephrasedReply: string;
        savedToMemory: boolean;
        chunksIndexed: number;
        notice?: string;
      }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ai_resolve_escalation",
            ticketId: ticket.id,
            escalationId: pendingEscalation?.id,
            adminRawAnswer: adminRawAnswer.trim(),
            rephrasedCustomerReply: memoryPreview?.customerReply,
            saveToMemory,
            canonicalMemoryTitle: memoryPreview?.canonicalMemoryTitle,
            canonicalQuestion: memoryPreview?.canonicalQuestion,
            canonicalAnswer: memoryPreview?.canonicalAnswer,
            resolveTicket: true,
          }),
        })
      );
      if (res.rephrasedReply) {
        onLoadIntoComposer(res.rephrasedReply);
      }
      setLocalNotice(
        res.notice ||
          "AI rephrased your answer into the reply composer and updated the ticket."
      );
      setAdminRawAnswer("");
      setMemoryPreview(null);
      await onRefreshTicket();
    } catch (e) {
      setLocalError(requestErrorMessage(e, "Failed to resolve AI escalation"));
    } finally {
      setBusy(false);
    }
  }

  const tokenPercent = Math.min(
    100,
    Math.round((threadTokenEstimate / Math.max(1, compactionThreshold)) * 100)
  );
  const exceedsCompactionThreshold = threadTokenEstimate >= compactionThreshold;

  return (
    <div className="shrink-0 border-b border-border bg-card/90 px-4 sm:px-6 py-2.5 space-y-2.5">
      {/* Row 1: AI Status + 10k-Token Compaction Meter + Quick AI Triggers */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-[11px] font-semibold text-success">
            <ShieldCheck size={12} /> {approvalModeEnabled ? "Approval Mode" : "Auto-Send Mode"}
          </span>

          {ticket.ai_status === "needs_admin_input" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/35 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-bold text-amber-800 dark:text-amber-300">
              <AlertTriangle size={12} /> AI Asking Admin for Store Context
            </span>
          )}

          {ticket.ai_status === "needs_human_action" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/35 bg-destructive/15 px-2.5 py-0.5 text-[11px] font-bold text-destructive">
              <AlertTriangle size={12} /> AI Escalated: Human Action Required
            </span>
          )}

          {ticket.ai_status === "draft_ready" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/35 bg-purple-500/15 px-2.5 py-0.5 text-[11px] font-bold text-purple-700 dark:text-purple-300">
              <CheckCircle2 size={12} /> AI Grounded Draft Ready
              {ticket.ai_confidence != null
                ? ` (${Math.round(Number(ticket.ai_confidence) * 100)}%)`
                : ""}
            </span>
          )}

          {/* 10,000-Token Compaction Indicator */}
          <button
            type="button"
            onClick={() => setSummaryOpen((v) => !v)}
            title="Click to view 10,000-token rolling conversation summary & pinned facts"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-mono transition cursor-pointer ${
              exceedsCompactionThreshold || ticket.ai_summary
                ? "border-purple-500/35 bg-purple-500/10 text-purple-700 dark:text-purple-300 font-semibold"
                : "border-border bg-muted/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileStack size={11} />
            <span>
              {threadTokenEstimate.toLocaleString()} / {compactionThreshold.toLocaleString()} tokens
            </span>
            {ticket.ai_summary && (
              <span className="rounded bg-purple-500/20 px-1.5 py-0.2 text-[10px]">
                Compacted ({tokenPercent}%)
              </span>
            )}
            {summaryOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>

          {/* Per-Chat Real Token & Spend Pill */}
          <button
            type="button"
            onClick={() => setTokenLogOpen((v) => !v)}
            title="Click to inspect per-chat and per-request AI token usage & cost"
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-mono text-amber-800 dark:text-amber-300 hover:bg-amber-500/15 transition cursor-pointer"
          >
            <Coins size={11} />
            <span>
              Chat AI: {formatTokensCompact(chatTokenTotals?.totalTokens || 0)} tok ·{" "}
              {formatCostUsd(chatTokenTotals?.estimatedCostUsd || 0)} (
              {formatCostInr(chatTokenTotals?.estimatedCostUsd || 0)})
            </span>
            {(chatTokenTotals?.requestCount || 0) > 0 && (
              <span className="text-[10px] opacity-80">
                ({chatTokenTotals?.requestCount} req)
              </span>
            )}
            {tokenLogOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setAdminPanelOpen((v) => !v)}
            className="h-7 px-2.5 text-[11px]"
          >
            <BrainCircuit size={12} className="text-primary" />
            {pendingEscalation
              ? "Answer AI Question"
              : adminPanelOpen
                ? "Hide AI Rephraser"
                : "Teach AI & Rephrase"}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void runAiOnTicket(true)}
            title="Build or refresh the rolling conversation compaction summary & pinned entities"
            className="h-7 px-2.5 text-[11px]"
          >
            <FileStack size={12} /> Compact Summary
          </Button>

          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => void runAiOnTicket(false)}
            className="h-7 px-2.5 text-[11px]"
          >
            <Sparkles size={12} /> {busy ? "Running AI..." : "Run AI Agent"}
          </Button>
        </div>
      </div>

      {/* Local AI Notice / Error */}
      {(localNotice || localError) && (
        <div
          className={`rounded-xl border px-3 py-1.5 text-xs flex items-center justify-between ${
            localError
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-purple-500/30 bg-purple-500/10 text-purple-800 dark:text-purple-200"
          }`}
        >
          <span>{localError || localNotice}</span>
          <button
            type="button"
            onClick={() => {
              setLocalError("");
              setLocalNotice("");
            }}
            className="underline font-semibold ml-2 cursor-pointer"
          >
            OK
          </button>
        </div>
      )}

      {/* Collapsible 10,000-Token Rolling Compaction Summary & Pinned Entity Ledger */}
      {summaryOpen && (
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-[11px] font-bold uppercase tracking-wider text-purple-800 dark:text-purple-300">
              10,000-Token Rolling Compaction Summary &amp; Pinned Facts Ledger
            </strong>
            <span className="text-[11px] text-muted-foreground">
              {exceedsCompactionThreshold
                ? "Thread exceeded 10,000 tokens — older turns automatically compacted"
                : "Rolling checkpoint passed to AI instead of full raw history when > 10,000 tokens"}
            </span>
          </div>

          {hasPinnedFacts && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Pinned Entities:
              </span>
              {pinnedFacts.orderCodes?.map((code) => (
                <span
                  key={code}
                  className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary"
                >
                  Order #{code}
                </span>
              ))}
              {pinnedFacts.phones?.map((ph) => (
                <span
                  key={ph}
                  className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] text-foreground"
                >
                  Phone: {ph}
                </span>
              ))}
              {pinnedFacts.awbNumbers?.map((awb) => (
                <span
                  key={awb}
                  className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] text-foreground"
                >
                  AWB: {awb}
                </span>
              ))}
              {pinnedFacts.mentionedSizes?.map((sz) => (
                <span
                  key={sz}
                  className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-800 dark:text-amber-300"
                >
                  Size: {sz}
                </span>
              ))}
            </div>
          )}

          {ticket.ai_summary ? (
            <div className="rounded-lg border border-border bg-card p-2.5 text-xs text-foreground whitespace-pre-wrap leading-relaxed">
              {ticket.ai_summary}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No compaction checkpoint generated yet (current thread is{" "}
              {threadTokenEstimate.toLocaleString()} tokens). Click{" "}
              <strong>Compact Summary</strong> above to generate a checkpoint now.
            </p>
          )}
        </div>
      )}

      {/* Expandable Per-Chat & Per-Request Token Breakdown */}
      {tokenLogOpen && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
              Per-Chat &amp; Per-Request AI Token Breakdown
            </strong>
            <span className="font-mono text-[11px] text-foreground">
              In: {(chatTokenTotals?.inputTokens || 0).toLocaleString()} · Out:{" "}
              {(chatTokenTotals?.outputTokens || 0).toLocaleString()} · Total:{" "}
              {(chatTokenTotals?.totalTokens || 0).toLocaleString()} tok ·{" "}
              <strong>{formatCostUsd(chatTokenTotals?.estimatedCostUsd || 0)}</strong> (
              {formatCostInr(chatTokenTotals?.estimatedCostUsd || 0)})
            </span>
          </div>

          {chatTokenLogs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No AI requests logged for this conversation yet. Run AI Agent or Teach AI to record per-request usage.
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-card">
              <table className="w-full text-left text-[11px] border-collapse">
                <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground border-b border-border">
                  <tr>
                    <th className="px-2.5 py-1.5">Request</th>
                    <th className="px-2.5 py-1.5">Model</th>
                    <th className="px-2.5 py-1.5 text-right">In / Out</th>
                    <th className="px-2.5 py-1.5 text-right">Total</th>
                    <th className="px-2.5 py-1.5 text-right">Cost</th>
                    <th className="px-2.5 py-1.5 text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {chatTokenLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-muted/20">
                      <td className="px-2.5 py-1 font-sans font-medium text-foreground capitalize">
                        {log.operationType.replaceAll("_", " ")}
                        {log.messageId ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            (linked msg)
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2.5 py-1 text-muted-foreground">{log.model}</td>
                      <td className="px-2.5 py-1 text-right text-muted-foreground">
                        {log.inputTokens.toLocaleString()} / {log.outputTokens.toLocaleString()}
                      </td>
                      <td className="px-2.5 py-1 text-right font-semibold text-foreground">
                        {log.totalTokens.toLocaleString()}
                      </td>
                      <td className="px-2.5 py-1 text-right text-amber-700 dark:text-amber-300">
                        {formatCostUsd(log.estimatedCostUsd)} ({formatCostInr(log.estimatedCostUsd)})
                      </td>
                      <td className="px-2.5 py-1 text-right text-muted-foreground font-sans">
                        {new Date(log.createdAt).toLocaleString("en-IN", {
                          day: "numeric",
                          month: "short",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Compact Pending Escalation Strip when collapsed */}
      {!adminPanelOpen && pendingEscalation && (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-xs flex items-center justify-between gap-2">
          <span className="text-amber-900 dark:text-amber-200 truncate">
            <strong className="font-semibold">AI Escalation:</strong> {pendingEscalation.ai_question_for_admin}
          </span>
          <button
            type="button"
            onClick={() => setAdminPanelOpen(true)}
            className="shrink-0 rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 cursor-pointer"
          >
            Answer AI
          </button>
        </div>
      )}

      {/* Collapsible Admin Clarification -> AI Rephrase -> Optional Save to AI Memory Card */}
      {adminPanelOpen && (
        <div className="rounded-2xl border-2 border-amber-500/35 bg-gradient-to-r from-amber-500/10 via-card to-purple-500/10 p-3.5 space-y-3 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900 dark:text-amber-200">
                  <Sparkles size={11} />
                  {pendingEscalation?.escalation_type === "human_action_required"
                    ? `Human Action Required: ${pendingEscalation.action_category.replaceAll("_", " ")}`
                    : "AI Asking Admin for Context & Rephrase-to-Resolve"}
                </span>
              </div>
              <p className="text-xs font-semibold text-foreground leading-snug">
                {pendingEscalation?.ai_question_for_admin ||
                  "Tell the AI the answer or facts in shorthand below — the AI will rephrase it into a polite customer response and optionally save it to AI Memory."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAdminPanelOpen(false)}
              className="text-[11px] text-muted-foreground hover:text-foreground underline cursor-pointer"
            >
              Collapse
            </button>
          </div>

          <div className="space-y-2">
            <textarea
              rows={2}
              value={adminRawAnswer}
              onChange={(e) => setAdminRawAnswer(e.target.value)}
              placeholder="Type your raw answer for the AI (e.g. 'Tell them custom sleeve length isn't available on ready-to-ship kurtas, only XS–XXL, and they can exchange within 7 days of delivery')..."
              className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring resize-y"
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={saveToMemory}
                  onChange={(e) => setSaveToMemory(e.target.checked)}
                  className="size-4 rounded border-input accent-primary cursor-pointer"
                />
                <span className="inline-flex items-center gap-1">
                  <Database size={12} className="text-purple-600 dark:text-purple-400" />
                  Save this response to <strong>AI Memory (Store RAG)</strong> as a reference for future questions
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy || !adminRawAnswer.trim()}
                  onClick={() => void handlePreviewRephrase()}
                  className="h-8 px-3 text-xs"
                >
                  <Sparkles size={12} /> AI Rephrase into Reply Box
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy || !adminRawAnswer.trim()}
                  onClick={() => void handleCommitEscalationAnswer()}
                  className="h-8 px-3 text-xs"
                >
                  <Send size={12} />{" "}
                  {saveToMemory
                    ? "Rephrase & Save to AI Memory"
                    : "Rephrase Only (Don't Save to Memory)"}
                </Button>
              </div>
            </div>
          </div>

          {/* Preview of Generalized PII-Scrubbed Memory Entry */}
          {memoryPreview && saveToMemory && (
            <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <strong className="text-[10px] uppercase tracking-wider text-purple-800 dark:text-purple-300">
                  PII-Scrubbed Canonical Q&amp;A Rule to be Indexed in AI Memory:
                </strong>
                <span className="text-[10px] font-mono text-muted-foreground">
                  Category: admin_memory (768-dim vector + FTS)
                </span>
              </div>
              <p className="text-xs font-semibold text-foreground">
                Q: {memoryPreview.canonicalQuestion}
              </p>
              <p className="text-xs text-muted-foreground">
                A: {memoryPreview.canonicalAnswer}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
