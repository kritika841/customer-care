"use client";

import { useState, type KeyboardEvent } from "react";
import {
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  Coins,
  Plus,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { readJson, requestErrorMessage } from "../lib/http";
import { formatCostUsd, formatCostInr, formatTokensCompact } from "../lib/support-ui";

type MemoryOp = {
  op: "create" | "update" | "delete" | "noop" | string;
  documentId?: string;
  title?: string;
  summary: string;
};

type MemoryResultEntry = {
  id: string;
  instruction: string;
  reply: string;
  operations: MemoryOp[];
  provider: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
};

const QUICK_MEMORY_PROMPTS = [
  {
    label: "Update Return / Exchange Window",
    text: "Remember that customers can exchange sizes within 7 days of delivery for unworn items with tags intact.",
  },
  {
    label: "Set Dispatch / Shipping SLA",
    text: "Remember that prepaid orders ship within 24 hours and standard delivery takes 3-5 business days across India.",
  },
  {
    label: "List Current AI Memories",
    text: "List everything you currently have stored in AI Memory.",
  },
  {
    label: "Refund Escalation Rule",
    text: "Always escalate manual refund requests to a human agent and never promise instant bank transfers.",
  },
];

export default function FloatingMemoryDock({
  modelLabel = "Gemini 2.5 Flash",
  memoryCount = 0,
  onMemoryUpdated,
  onOpenAiBrain,
}: {
  modelLabel?: string;
  memoryCount?: number;
  onMemoryUpdated?: () => void;
  onOpenAiBrain?: () => void;
}) {
  const [minimized, setMinimized] = useState(true);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [latestResult, setLatestResult] = useState<MemoryResultEntry | null>(null);
  const [resultExpanded, setResultExpanded] = useState(true);

  async function handleSubmit(textOverride?: string) {
    const clean = (textOverride ?? instruction).trim();
    if (!clean || busy) return;

    setBusy(true);
    setError("");
    setPresetsOpen(false);
    try {
      const res = await readJson<{
        ok: boolean;
        assistantReply: string;
        operations: MemoryOp[];
        provider: string;
        model: string;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          estimatedCostUsd: number;
        };
      }>(
        await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ai_memory_command",
            instruction: clean,
          }),
        }),
      );
      setLatestResult({
        id: `${Date.now()}`,
        instruction: clean,
        reply: res.assistantReply || "Updated AI Memory.",
        operations: res.operations || [],
        provider: res.provider || "ai",
        model: res.model || modelLabel,
        usage: res.usage,
      });
      setResultExpanded(true);
      setInstruction("");
      onMemoryUpdated?.();
    } catch (err) {
      setError(requestErrorMessage(err, "Failed to update AI memory"));
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  if (minimized) {
    return (
      <div className="fixed bottom-4 right-5 z-40">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          data-testid="floating-ai-memory-toggle"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card/95 px-3.5 py-2 text-xs font-semibold text-foreground shadow-lg backdrop-blur-md hover:border-primary/50 hover:bg-accent/60 transition cursor-pointer"
        >
          <BrainCircuit size={14} className="text-primary" />
          <span>Update AI Memory</span>
          {memoryCount > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.2 text-[10px] font-mono font-bold text-primary">
              {memoryCount}
            </span>
          )}
          <ChevronUp size={13} className="text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="floating-ai-memory-dock"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 lg:left-[calc(50%+7rem)] z-40 w-[calc(100%-1.5rem)] max-w-[660px] pointer-events-none"
    >
      <div className="pointer-events-auto space-y-2">
        {/* Response / Memory Diff Card */}
        {(error || latestResult) && (
          <div className="rounded-2xl border border-border bg-card/95 text-card-foreground shadow-xl backdrop-blur-md overflow-hidden">
            {error ? (
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs text-destructive bg-destructive/10">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => setError("")}
                  className="text-muted-foreground hover:text-foreground cursor-pointer"
                  aria-label="Dismiss memory error"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              latestResult && (
                <div>
                  <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-muted/40 text-[11px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <Sparkles size={13} className="text-primary shrink-0" />
                      <span className="font-semibold text-foreground truncate">
                        {latestResult.instruction}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {latestResult.usage && latestResult.usage.totalTokens > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          <Coins size={10} className="text-amber-500" />
                          {formatTokensCompact(latestResult.usage.totalTokens)} tok ·{" "}
                          {formatCostUsd(latestResult.usage.estimatedCostUsd)}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setResultExpanded((v) => !v)}
                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                        aria-label="Toggle memory response"
                      >
                        {resultExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setLatestResult(null)}
                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                        aria-label="Close memory response"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>

                  {resultExpanded && (
                    <div className="px-4 py-2.5 space-y-2 text-xs">
                      <p className="text-foreground leading-relaxed whitespace-pre-line">
                        {latestResult.reply}
                      </p>
                      {latestResult.operations.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {latestResult.operations.map((op, i) => (
                            <span
                              key={`${op.op}-${i}`}
                              className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-medium border ${
                                op.op === "create"
                                  ? "bg-success/15 text-success border-success/30"
                                  : op.op === "update"
                                    ? "bg-primary/15 text-primary border-primary/30"
                                    : op.op === "delete"
                                      ? "bg-destructive/15 text-destructive border-destructive/30"
                                      : "bg-muted text-muted-foreground border-border"
                              }`}
                            >
                              <strong className="uppercase">{op.op}</strong>
                              <span>{op.summary}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {latestResult.usage && latestResult.usage.totalTokens > 0 && (
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {latestResult.model} · In:{" "}
                          {latestResult.usage.inputTokens.toLocaleString()} / Out:{" "}
                          {latestResult.usage.outputTokens.toLocaleString()} ·{" "}
                          {formatCostUsd(latestResult.usage.estimatedCostUsd)} (
                          {formatCostInr(latestResult.usage.estimatedCostUsd)})
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        )}

        {/* Quick Preset Popover above the + button */}
        {presetsOpen && (
          <div className="rounded-2xl border border-border bg-card/95 p-2 shadow-xl backdrop-blur-md space-y-1">
            <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Quick AI Memory Commands</span>
              {onOpenAiBrain && (
                <button
                  type="button"
                  onClick={() => {
                    setPresetsOpen(false);
                    onOpenAiBrain();
                  }}
                  className="text-primary hover:underline cursor-pointer font-semibold"
                >
                  Open Full Memory Bank
                </button>
              )}
            </div>
            {QUICK_MEMORY_PROMPTS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  setInstruction(preset.text);
                  setPresetsOpen(false);
                }}
                className="w-full text-left rounded-xl px-2.5 py-1.5 text-xs text-foreground hover:bg-muted/70 transition cursor-pointer"
              >
                <span className="font-semibold block">{preset.label}</span>
                <span className="text-[11px] text-muted-foreground line-clamp-1">{preset.text}</span>
              </button>
            ))}
          </div>
        )}

        {/* Hovering Theme-Matched Rounded Prompt Container */}
        <div className="rounded-[22px] border border-primary/35 bg-card/95 px-4 pt-3 pb-2.5 shadow-[0_14px_38px_rgba(0,0,0,0.28)] backdrop-blur-md focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 transition">
          <textarea
            rows={1}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            placeholder="How can I help update AI memory today? (e.g. 'Remember size exchange is 7 days' or 'List memories')"
            aria-label="Instruct AI agent to update memory"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none leading-snug max-h-28"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPresetsOpen((v) => !v)}
                title="Insert quick AI memory instruction"
                className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer"
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                onClick={() => onOpenAiBrain?.()}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition cursor-pointer"
                title="Open AI Brain & Stored Memories"
              >
                <BrainCircuit size={13} className="text-primary" />
                <span>AI Memory</span>
                <span className="font-mono text-[10px] text-muted-foreground">({memoryCount})</span>
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="hidden sm:inline rounded-md bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {modelLabel}
              </span>
              <span className="hidden sm:inline text-[11px] text-muted-foreground">
                Auto-PII Scrub
              </span>
              <button
                type="button"
                onClick={() => setMinimized(true)}
                title="Hide AI Memory box"
                className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer"
              >
                Hide
              </button>
              <button
                type="button"
                disabled={busy || !instruction.trim()}
                onClick={() => void handleSubmit()}
                title="Run AI Memory command (Enter)"
                aria-label="Send memory command to AI"
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
              >
                <Send size={12} />
                <span>{busy ? "Updating..." : "Update"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
