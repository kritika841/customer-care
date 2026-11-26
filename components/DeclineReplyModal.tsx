"use client";

import { useState } from "react";
import { AlertTriangle, BrainCircuit, Send, X } from "lucide-react";
import { Button } from "./ui/button";

export default function DeclineReplyModal({
  ticket,
  busy,
  onClose,
  onSubmit,
}: {
  ticket: {
    id: string;
    ticketNumber: number;
    customerLabel: string;
    customerQuery: string;
    proposedReply: string;
    version?: number;
  } | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    ticketId: string;
    version?: number;
    customerQuery: string;
    proposedReply: string;
    declineReason: string;
    correctedReply: string;
  }) => Promise<void>;
}) {
  const [declineReason, setDeclineReason] = useState("");
  const [correctedReply, setCorrectedReply] = useState(ticket?.proposedReply || "");

  if (!ticket) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close decline modal"
        onClick={onClose}
        className="fixed inset-0 bg-black/55 backdrop-blur-[2px] cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-2xl rounded-2xl border border-border bg-card shadow-float overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
              <AlertTriangle size={16} />
            </span>
            <div>
              <h3 className="text-sm font-bold text-foreground">
                Decline &amp; Correct AI Response · #{String(ticket.ticketNumber).padStart(4, "0")}
              </h3>
              <p className="text-[11px] text-muted-foreground">{ticket.customerLabel}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close decline modal"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!declineReason.trim() || !correctedReply.trim()) return;
            await onSubmit({
              ticketId: ticket.id,
              version: ticket.version,
              customerQuery: ticket.customerQuery,
              proposedReply: ticket.proposedReply,
              declineReason: declineReason.trim(),
              correctedReply: correctedReply.trim(),
            });
          }}
          className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs"
        >
          <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Customer Request Received
            </span>
            <p className="text-xs text-foreground whitespace-pre-line leading-relaxed max-h-28 overflow-y-auto">
              {ticket.customerQuery}
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
              Reason for Declining *
            </span>
            <input
              type="text"
              required
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="e.g. Incorrect exchange window — Satmi offers 14-day size exchanges, not 7 days"
              className="h-9 w-full rounded-xl border border-input bg-background px-3 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
              Corrected Response to Send *
            </span>
            <textarea
              required
              rows={5}
              value={correctedReply}
              onChange={(e) => setCorrectedReply(e.target.value)}
              placeholder="Write the accurate response to send to the customer..."
              className="w-full rounded-xl border border-input bg-background p-3 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 resize-y"
            />
          </label>

          <div className="rounded-xl border border-purple-500/25 bg-purple-500/5 px-3 py-2.5 flex items-start gap-2 text-[11px] text-muted-foreground">
            <BrainCircuit size={14} className="text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
            <span>
              The AI will learn from your decline reason and correction for general store/product questions.{" "}
              <strong className="text-foreground">Order-specific queries are automatically excluded</strong> so individual order details are never reused for other customers.
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || !declineReason.trim() || !correctedReply.trim()}
            >
              <Send size={13} /> Send Correction &amp; Teach AI
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
