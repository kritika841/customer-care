"use client";

import { useState } from "react";
import {
  ExternalLink,
  Link2,
  LockKeyhole,
  Mail,
  MapPin,
  Package,
  Phone,
  Search,
  Star,
  StickyNote,
  Tag,
  Truck,
  Unlink,
} from "lucide-react";
import { Button } from "./ui/button";
import { readJson } from "../lib/http";
import type { Customer360Summary } from "../lib/operations/sla";

type OrderSearchHit = {
  id: number;
  channel_order_id: string;
  status: string;
  awb: string;
  courier: string;
  total: string | number | null;
  payment_method: string;
  order_date: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
};

type MessageItem = {
  id: string;
  body: string;
  sender: string;
  created_at: string;
};

type EventItem = {
  id: string;
  action: string;
  created_at: string;
};

type OrderItem = {
  id?: number;
  channel_order_id?: string;
  channelOrderId?: string;
  status?: string;
  awb?: string;
  courier?: string;
  tracking_url?: string;
  total?: string | number | null;
  payment_method?: string | null;
  order_date?: string | null;
};

function deduplicateCustomerTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const clean = String(raw || "").trim();
    if (!clean) continue;
    const norm = clean.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(clean.replaceAll("_", " "));
  }
  return result;
}

export default function CustomerProfileSidebar({
  visibleOnMobile,
  ticket,
  internalNotes,
  noteBody,
  onNoteBodyChange,
  onSendNote,
  noteInputRef,
  activeCustomer,
  customer360,
  linkedCustomer,
  orders,
  events,
  busy,
  priorityBadgeClass,
  formatShortDate,
  visibleBody,
  onLinkCustomer,
  onUnlinkCustomer,
  onTrackOrder,
}: {
  visibleOnMobile: boolean;
  ticket: {
    id?: string;
    channel?: string;
    priority?: string;
    customer_email?: string;
    customer_name?: string;
    external_username?: string;
    csat_score?: number | null;
    csat_comment?: string | null;
  };
  internalNotes: MessageItem[];
  noteBody: string;
  onNoteBodyChange: (v: string) => void;
  onSendNote: () => void;
  noteInputRef: React.RefObject<HTMLTextAreaElement | null>;
  activeCustomer: {
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
  orders: OrderItem[];
  events: EventItem[];
  busy: boolean;
  priorityBadgeClass: string;
  formatShortDate: (s: unknown) => string;
  visibleBody: (raw: string) => string;
  onLinkCustomer: (hit: OrderSearchHit) => Promise<void>;
  onUnlinkCustomer: () => Promise<void>;
  onTrackOrder?: (target: {
    awb?: string;
    orderId?: number | null;
    orderCode?: string;
    ticketId?: string;
    courier?: string;
    trackingUrl?: string;
  }) => void;
}) {
  const [linkSearchOpen, setLinkSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<OrderSearchHit[]>([]);
  const [searchError, setSearchError] = useState("");
  const uniqueTags = deduplicateCustomerTags(activeCustomer.tags || []);
  const rawEmail = activeCustomer.email || ticket.customer_email || "";
  const displayEmail = rawEmail && !rawEmail.endsWith("@facebook.com") ? rawEmail : "";

  async function runOrderSearch(q: string) {
    setSearchQuery(q);
    if (q.trim().length < 3) {
      setSearchHits([]);
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const payload = await readJson<{ results: OrderSearchHit[] }>(
        await fetch(
          "/api/support?" +
            new URLSearchParams({
              mode: "customer_search",
              q: q.trim(),
              ...(ticket.id ? { ticketId: ticket.id } : {}),
            }),
          { cache: "no-store" },
        ),
      );
      setSearchHits(payload.results || []);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  return (
    <aside
      className={`${
        visibleOnMobile ? "flex" : "hidden lg:flex"
      } w-full min-h-0 border-t lg:border-t-0 lg:border-l border-border bg-card flex-col overflow-y-auto max-h-[42vh] lg:max-h-full lg:h-full divide-y divide-border`}
    >
      {/* 1. TOP-RIGHT INTERNAL NOTES & PRIORITY */}
      <section className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StickyNote size={15} className="text-amber-600 dark:text-amber-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
              Internal Notes ({internalNotes.length})
            </h3>
          </div>
          <div className="flex items-center gap-1.5">
            {ticket.csat_score != null && (
              <span
                title={ticket.csat_comment || "Customer CSAT rating"}
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300"
              >
                <Star size={10} className="fill-amber-400 text-amber-400" />
                {ticket.csat_score}/5
              </span>
            )}
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${priorityBadgeClass}`}
            >
              {ticket.priority}
            </span>
          </div>
        </div>

        {internalNotes.length > 0 ? (
          <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
            {internalNotes.map((note) => (
              <div
                key={note.id}
                className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-2 text-[10px] text-amber-800 dark:text-amber-300 font-semibold">
                  <span className="inline-flex items-center gap-1 truncate">
                    <LockKeyhole size={10} /> {note.sender || "Team"}
                  </span>
                  <time>{formatShortDate(note.created_at)}</time>
                </div>
                <p className="text-xs text-foreground whitespace-pre-wrap break-words leading-relaxed">
                  {visibleBody(note.body)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No internal notes yet. Notes stay private to your team.
          </p>
        )}

        <div className="space-y-2 pt-1">
          <textarea
            ref={noteInputRef}
            aria-label="Add internal note"
            value={noteBody}
            onChange={(e) => onNoteBodyChange(e.target.value)}
            rows={2}
            placeholder="Add a private note for teammates…"
            className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring resize-y"
          />
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={busy || !noteBody.trim()}
              onClick={onSendNote}
            >
              <LockKeyhole size={12} /> Add note
            </Button>
          </div>
        </div>
      </section>

      {/* 2. CUSTOMER INFORMATION + SEARCH & LINK + CUSTOMER 360 */}
      <section className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
            Customer Information
          </h3>
          <div className="flex items-center gap-1.5">
            {linkedCustomer.isLinked && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onUnlinkCustomer()}
                title="Unlink saved customer/order mapping"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-destructive transition cursor-pointer"
              >
                <Unlink size={10} /> Unlink
              </button>
            )}
            <button
              type="button"
              onClick={() => setLinkSearchOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/15 transition cursor-pointer"
            >
              <Link2 size={11} /> {linkSearchOpen ? "Hide search" : "Link order"}
            </button>
          </div>
        </div>

        {/* Search & Link Order / Customer Box */}
        {linkSearchOpen && (
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 space-y-2.5">
            <div className="relative flex items-center">
              <Search size={13} className="absolute left-2.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => void runOrderSearch(e.target.value)}
                placeholder="Search order #, phone, email, AWB, name…"
                className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Attaching links this conversation and remembers future DMs from this customer.
            </p>
            {searching && <p className="text-[11px] text-muted-foreground">Searching orders…</p>}
            {searchError && <p className="text-[11px] text-destructive">{searchError}</p>}
            {!searching && searchQuery.trim().length >= 2 && searchHits.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No matching Shopify orders found.</p>
            )}
            {searchHits.length > 0 && (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                {searchHits.map((hit) => (
                  <div
                    key={hit.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-[11px]"
                  >
                    <div className="min-w-0">
                      <strong className="block font-mono font-semibold text-foreground truncate">
                        {hit.channel_order_id || `#${hit.id}`} · {hit.status}
                      </strong>
                      <span className="block text-muted-foreground truncate">
                        {hit.customer_name || hit.customer_email}
                        {hit.customer_phone ? ` · ${hit.customer_phone}` : ""}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      className="h-7 px-2.5 text-[11px] shrink-0"
                      onClick={async () => {
                        await onLinkCustomer(hit);
                        setLinkSearchOpen(false);
                        setSearchQuery("");
                        setSearchHits([]);
                      }}
                    >
                      Attach
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Identity Card */}
        <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2.5 text-xs">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">
              {(activeCustomer.name || ticket.customer_name || ticket.external_username || "C")
                .slice(0, 2)
                .toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <strong className="block text-sm font-semibold text-foreground truncate">
                  {activeCustomer.name || ticket.customer_name || "Customer"}
                </strong>
                {linkedCustomer.isLinked && (
                  <span className="rounded-full bg-success/15 px-1.5 py-0.2 text-[9px] font-bold text-success">
                    Linked
                  </span>
                )}
              </div>
              {ticket.external_username && (
                <span className="block text-[11px] font-medium text-primary truncate">
                  {ticket.external_username}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-1.5 pt-2 border-t border-border/60 text-muted-foreground">
            {displayEmail && (
              <div className="flex items-center gap-2 min-w-0">
                <Mail size={13} className="shrink-0 text-primary" />
                <span className="truncate text-foreground">{displayEmail}</span>
              </div>
            )}
            {activeCustomer.phone && (
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Phone size={13} className="shrink-0 text-primary" />
                  <span className="text-foreground font-mono">{activeCustomer.phone}</span>
                </span>
                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[9px] font-bold text-success">
                  Associated
                </span>
              </div>
            )}
            {(activeCustomer.city || activeCustomer.state) && (
              <div className="flex items-center gap-2">
                <MapPin size={13} className="shrink-0 text-primary" />
                <span className="text-foreground">
                  {[activeCustomer.city, activeCustomer.state].filter(Boolean).join(", ")}
                </span>
              </div>
            )}
          </div>

          {uniqueTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/60">
              <Tag size={12} className="text-muted-foreground shrink-0" />
              {uniqueTags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-amber-500/15 border border-amber-500/25 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400 capitalize"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Aggregated Customer 360 Summary (only shown when customer has orders) */}
        {customer360.totalOrders > 0 && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-border bg-background p-2.5">
              <span className="block text-[10px] text-muted-foreground">Orders</span>
              <strong className="text-sm font-bold text-foreground">
                {customer360.totalOrders}
              </strong>
              <span className="block text-[10px] text-muted-foreground">
                {customer360.pastTicketsCount} past ticket{customer360.pastTicketsCount === 1 ? "" : "s"}
              </span>
            </div>

            <div className="rounded-xl border border-border bg-background p-2.5">
              <span className="block text-[10px] text-muted-foreground">Lifetime Spend</span>
              <strong className="text-sm font-bold text-foreground font-mono">
                ₹{customer360.totalSpend.toLocaleString("en-IN")}
              </strong>
              <span className="block text-[10px] text-muted-foreground">
                COD {customer360.codOrders} · Pre {customer360.prepaidOrders}
              </span>
            </div>

            <div className="rounded-xl border border-border bg-background p-2.5">
              <span className="block text-[10px] text-muted-foreground">RTO History</span>
              <strong
                className={`text-sm font-bold ${
                  customer360.rtoOrders > 0 ? "text-destructive" : "text-success"
                }`}
              >
                {customer360.rtoOrders} ({customer360.rtoRatePercent}%)
              </strong>
              <span className="block text-[10px] text-muted-foreground">
                {customer360.deliveredOrders} delivered
              </span>
            </div>
          </div>
        )}

        {/* Linked Orders & One-Click Tracking */}
        <div className="space-y-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block">
            Orders &amp; Tracking ({orders.length})
          </span>
          {orders.length ? (
            <div className="space-y-2">
              {orders.map((o) => {
                const orderCode = o.channel_order_id || o.channelOrderId || `#${o.id}`;
                return (
                  <div
                    key={o.id}
                    className="rounded-xl border border-border bg-background p-2.5 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-foreground">
                        <Package size={12} className="text-primary" />
                        {orderCode}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold capitalize text-foreground">
                        {o.status}
                      </span>
                    </div>
                    {(o.courier || o.awb || orderCode || o.tracking_url) && (
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-muted-foreground font-mono truncate">
                          {o.courier ? `${o.courier} · ` : ""}
                          {o.awb ? `Tracking: ${o.awb}` : "Live tracking"}
                        </p>
                        <div className="inline-flex shrink-0 items-center gap-1">
                          {(o.awb || orderCode) && onTrackOrder && (
                            <button
                              type="button"
                              onClick={() =>
                                onTrackOrder({
                                  awb: o.awb,
                                  orderId: o.id ?? null,
                                  orderCode,
                                  ticketId: ticket.id,
                                  courier: o.courier,
                                  trackingUrl: o.tracking_url,
                                })
                              }
                              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground transition cursor-pointer"
                            >
                              <Truck size={10} /> Track
                            </button>
                          )}
                          {o.tracking_url && (
                            <a
                              href={o.tracking_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open courier tracking page"
                              className="inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-background/60 p-1 text-muted-foreground hover:text-primary hover:border-primary/40 transition"
                            >
                              <ExternalLink size={10} />
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                    {(o.total != null || o.payment_method) && (
                      <p className="text-[11px] text-muted-foreground">
                        {o.total != null ? `Rs. ${o.total}` : ""}
                        {o.payment_method ? ` · ${o.payment_method}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No orders linked yet. Use <strong>Link order</strong> above to attach one.
            </p>
          )}
        </div>

        {/* Case Activity */}
        {!!events.length && (
          <details className="rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-semibold text-foreground">
              Case activity ({events.length})
            </summary>
            <div className="mt-2 space-y-1 pl-2 border-l border-border">
              {events.map((ev) => (
                <div key={ev.id}>
                  {formatShortDate(ev.created_at)} · {ev.action.replaceAll("_", " ")}
                </div>
              ))}
            </div>
          </details>
        )}
      </section>
    </aside>
  );
}
