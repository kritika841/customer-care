"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Package,
  Phone,
  Send,
  Sparkles,
  Truck,
} from "lucide-react";
import { Button } from "./ui/button";
import { cleanTicketPreviewText, formatShortDate, getChannelBadge, type CustomerInfo, type Message } from "../lib/support-ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueueTicketSummary = Record<string, any>;

type QueueOrder = {
  id?: number;
  channel_order_id?: string;
  status?: string;
  awb?: string;
  courier?: string;
  tracking_url?: string;
};

export default function AgentQueueView({
  queueTickets,
  activeTicketId,
  selectedTicket,
  messages,
  orders,
  customer,
  busy,
  onSelectTicket,
  onSendAiResponse,
  onSendCorrectedResponse,
  onTrackOrder,
}: {
  queueTickets: QueueTicketSummary[];
  activeTicketId: string;
  selectedTicket: QueueTicketSummary | null;
  messages: Message[];
  orders: QueueOrder[];
  customer: CustomerInfo;
  busy: boolean;
  onSelectTicket: (ticketId: string) => void;
  onSendAiResponse: (ticketId: string, proposedBody: string, version?: number) => Promise<boolean>;
  onSendCorrectedResponse: (payload: {
    ticketId: string;
    version?: number;
    customerQuery: string;
    proposedReply: string;
    declineReason: string;
    correctedReply: string;
  }) => Promise<boolean>;
  onTrackOrder: (target: {
    awb?: string;
    orderId?: number | null;
    orderCode?: string;
    ticketId?: string;
    courier?: string;
    trackingUrl?: string;
  }) => void;
}) {
  const activeIdx = Math.max(
    0,
    queueTickets.findIndex((t) => t.id === activeTicketId),
  );
  const currentSummary = queueTickets[activeIdx] || queueTickets[0] || null;
  const activeId = currentSummary?.id || "";

  useEffect(() => {
    if (activeId && activeId !== activeTicketId) {
      onSelectTicket(activeId);
    }
  }, [activeId, activeTicketId, onSelectTicket]);

  const ticketMatched = selectedTicket?.id === activeId;
  const scopedMessages = messages.filter((m) =>
    m.ticket_id ? m.ticket_id === activeId : ticketMatched,
  );
  const chatMessages = scopedMessages.filter((m) => m.direction !== "note");
  const aiDraftMsg = [...chatMessages]
    .reverse()
    .find((m) => m.delivery_status === "ai_draft");
  const visibleChat = chatMessages.filter((m) => m.delivery_status !== "ai_draft");
  const latestInbound = [...visibleChat].reverse().find((m) => m.direction === "inbound");

  const [draftEdits, setDraftEdits] = useState<
    Record<string, { body?: string; reason?: string }>
  >({});
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const defaultDraft = aiDraftMsg?.body || currentSummary?.ai_reply_body || "";
  const composerBody = draftEdits[activeId]?.body ?? defaultDraft;
  const correctionReason = draftEdits[activeId]?.reason ?? "";

  const setComposerBody = (val: string) =>
    setDraftEdits((prev) => ({
      ...prev,
      [activeId]: { ...prev[activeId], body: val },
    }));

  const setCorrectionReason = (val: string) =>
    setDraftEdits((prev) => ({
      ...prev,
      [activeId]: { ...prev[activeId], reason: val },
    }));

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeId, visibleChat.length]);

  function advanceToNext(excludeId: string) {
    const remaining = queueTickets.filter((t) => t.id !== excludeId);
    if (remaining.length > 0) {
      const next = remaining[Math.min(activeIdx, remaining.length - 1)];
      if (next) onSelectTicket(next.id);
    }
  }

  if (queueTickets.length === 0) {
    return (
      <div className="panel py-20 px-6 flex flex-col items-center justify-center text-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-success/15 text-success">
          <CheckCircle2 size={24} />
        </div>
        <h2 className="text-base font-bold text-foreground">
          Human Intervention Queue is Clear
        </h2>
        <p className="text-xs text-muted-foreground max-w-md">
          All queries needing human review, phone-mismatch verification, or escalated support actions have been handled.
        </p>
      </div>
    );
  }

  const ticket = selectedTicket?.id === activeId ? selectedTicket : currentSummary;
  if (!ticket) return null;
  const ch = getChannelBadge(ticket.channel);
  const primaryOrder = orders[0];
  const orderCode = primaryOrder?.channel_order_id || ticket.order_code || "";
  const trackingId = primaryOrder?.awb || ticket.order_tracking_id || "";
  const courier = primaryOrder?.courier || ticket.order_courier || "";
  const assocPhone = customer.phone || ticket.resolved_customer_phone || "";
  const aiProposed = aiDraftMsg?.body || ticket.ai_reply_body || "";

  return (
    <div className="panel overflow-hidden flex flex-col h-[calc(100vh-7.5rem)] min-h-[520px]">
      {/* Queue Top Strip */}
      <div className="shrink-0 border-b border-border bg-muted/35 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-bold text-primary-foreground font-mono">
            Queue {activeIdx + 1} / {queueTickets.length}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ch.className}`}>
            <span className={`size-1.5 rounded-full ${ch.dotClass}`} />
            {ch.shortLabel}
          </span>
          <strong className="text-sm font-bold text-foreground truncate">
            {customer.name || ticket.external_username || ticket.customer_name || ticket.customer_email}
          </strong>
          <span className="font-mono text-xs text-muted-foreground">
            #{String(ticket.ticket_number).padStart(4, "0")}
          </span>
          {ticket.ai_action_category && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/35 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300 capitalize">
              <AlertTriangle size={11} />
              {String(ticket.ai_action_category).replaceAll("_", " ")}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {assocPhone && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground">
              <Phone size={11} className="text-primary" /> {assocPhone}
            </span>
          )}
          {orderCode && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground">
              <Package size={11} className="text-primary" /> {orderCode}
            </span>
          )}
          {trackingId && (
            <button
              type="button"
              onClick={() =>
                onTrackOrder({
                  awb: trackingId,
                  orderId: primaryOrder?.id,
                  orderCode,
                  ticketId: ticket.id,
                  courier,
                  trackingUrl: primaryOrder?.tracking_url,
                })
              }
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground transition cursor-pointer"
            >
              <Truck size={11} /> Track: {trackingId}
            </button>
          )}
          <div className="flex items-center gap-1 ml-1">
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={queueTickets.length <= 1}
              onClick={() => {
                const prev = queueTickets[(activeIdx - 1 + queueTickets.length) % queueTickets.length];
                if (prev) onSelectTicket(prev.id);
              }}
            >
              <ChevronLeft size={14} /> Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={queueTickets.length <= 1}
              onClick={() => {
                const next = queueTickets[(activeIdx + 1) % queueTickets.length];
                if (next) onSelectTicket(next.id);
              }}
            >
              Skip <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </div>

      {/* Why Human Intervention Was Triggered */}
      {ticket.ai_question_for_admin && (
        <div className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="leading-snug">{ticket.ai_question_for_admin}</span>
        </div>
      )}

      {/* Chat-Only Message Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-3 bg-muted/15">
        {visibleChat.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
            <MessageSquare size={24} className="opacity-40" />
            <p className="text-xs">Loading conversation…</p>
          </div>
        ) : (
          visibleChat.map((m) => {
            const isOutbound = m.direction === "outbound";
            return (
              <div key={m.id} className={`flex w-full ${isOutbound ? "justify-end" : "justify-start"}`}>
                <article
                  className={`max-w-[82%] sm:max-w-[68%] rounded-2xl border px-4 py-2.5 text-xs shadow-xs ${
                    isOutbound
                      ? "rounded-tr-sm border-primary/30 bg-primary/10 text-foreground"
                      : "rounded-tl-sm border-border bg-card text-foreground"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground mb-1">
                    <strong className="font-semibold text-foreground">
                      {isOutbound ? "Satmi Support" : customer.name || ticket.customer_name || "Customer"}
                    </strong>
                    <time>{formatShortDate(m.created_at)}</time>
                  </div>
                  <p className="whitespace-pre-wrap break-words leading-relaxed">
                    {cleanTicketPreviewText(m.body, m.body)}
                  </p>
                </article>
              </div>
            );
          })
        )}
        <div ref={threadEndRef} />
      </div>

      {/* Bottom: Send AI Response OR Correct AI & Send */}
      <div className="shrink-0 border-t border-border bg-card p-3.5 space-y-2.5">
        {aiProposed && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-purple-500/25 bg-purple-500/5 px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-purple-700 dark:text-purple-300">
              <Sparkles size={13} /> AI Draft Ready — edit below or send immediately
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              className="h-7 px-2.5 text-[11px]"
              onClick={async () => {
                const ok = await onSendAiResponse(ticket.id, aiProposed, ticket.version);
                if (ok) advanceToNext(ticket.id);
              }}
            >
              <Send size={12} /> Send AI Response As-Is
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
          <div className="space-y-2">
            {aiProposed && (
              <input
                type="text"
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                placeholder="Optional: reason if correcting AI (general corrections teach AI; order-specific queries are skipped)…"
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring"
              />
            )}
            <textarea
              rows={3}
              value={composerBody}
              onChange={(e) => setComposerBody(e.target.value)}
              placeholder="Write or correct the response for this customer…"
              className="w-full rounded-xl border border-input bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring resize-y"
            />
          </div>

          <Button
            variant="primary"
            size="sm"
            disabled={busy || !composerBody.trim()}
            className="h-10 px-4 text-xs shrink-0"
            onClick={async () => {
              const replyText = composerBody.trim();
              if (!replyText) return;
              const isEdited = Boolean(aiProposed && replyText !== aiProposed.trim()) || Boolean(correctionReason.trim());
              const ok = await onSendCorrectedResponse({
                ticketId: ticket.id,
                version: ticket.version,
                customerQuery: latestInbound?.body || ticket.subject || "",
                proposedReply: aiProposed,
                declineReason:
                  correctionReason.trim() ||
                  (isEdited ? "Agent corrected response in Human Intervention Queue" : "Agent handled in Human Intervention Queue"),
                correctedReply: replyText,
              });
              if (ok) advanceToNext(ticket.id);
            }}
          >
            <Send size={13} /> Send &amp; Next Query
          </Button>
        </div>
      </div>
    </div>
  );
}
