"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, MapPin, Package, RefreshCw, Truck, X } from "lucide-react";
import { Button } from "./ui/button";
import { readJson, requestErrorMessage } from "../lib/http";
import type { OrderTrackingDetails } from "../lib/operations/rag";

export default function OrderTrackingModal({
  target,
  onClose,
}: {
  target: {
    awb?: string;
    orderId?: number | null;
    orderCode?: string;
    ticketId?: string;
    courier?: string;
    trackingUrl?: string;
  } | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tracking, setTracking] = useState<OrderTrackingDetails | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    async function load() {
      if (!target) return;
      setTracking(null);
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ mode: "track_order" });
        if (target.awb) params.set("awb", target.awb);
        if (target.orderId) params.set("orderId", String(target.orderId));
        if (target.orderCode) params.set("orderCode", target.orderCode);
        if (target.ticketId) params.set("ticketId", target.ticketId);
        const res = await readJson<{ tracking: OrderTrackingDetails }>(
          await fetch(`/api/support?${params.toString()}`, { cache: "no-store" }),
        );
        if (!cancelled) setTracking(res.tracking);
      } catch (e) {
        if (!cancelled) setError(requestErrorMessage(e, "Could not fetch tracking info"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;

  const displayAwb = tracking?.awb || target.awb || "";
  const displayCourier = tracking?.courier || target.courier || "Courier";
  const displayUrl = tracking?.trackingUrl || target.trackingUrl || "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close tracking modal"
        onClick={onClose}
        className="fixed inset-0 bg-black/55 backdrop-blur-[2px] cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-card shadow-float overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Truck size={17} />
            </span>
            <div>
              <h3 className="text-sm font-bold text-foreground">
                Order Tracking {tracking?.orderCode || target.orderCode || ""}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {displayCourier} {displayAwb ? `· AWB ${displayAwb}` : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tracking modal"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto text-xs">
          {loading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-muted-foreground">
              <RefreshCw size={15} className="spin" /> Fetching live tracking status…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-destructive">
              {error}
            </div>
          ) : tracking ? (
            <>
              <div className="rounded-xl border border-border bg-muted/30 p-3.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold text-foreground">
                    <Package size={13} className="text-primary" />
                    {tracking.awb || "No AWB assigned yet"}
                  </span>
                  <span className="rounded-full bg-primary/15 border border-primary/30 px-2.5 py-0.5 text-[11px] font-bold text-primary uppercase">
                    {tracking.status}
                  </span>
                </div>
                {tracking.currentLocation && (
                  <p className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <MapPin size={11} className="text-primary" /> Current location:{" "}
                    <strong className="text-foreground">{tracking.currentLocation}</strong>
                  </p>
                )}
                {tracking.etd && (
                  <p className="text-[11px] text-muted-foreground">
                    Estimated Delivery: <strong className="text-foreground">{tracking.etd}</strong>
                  </p>
                )}
                {tracking.ndrReason && (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
                    NDR Exception: {tracking.ndrReason}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Source:{" "}
                  {tracking.source === "shiprocket_live"
                    ? "Live Shiprocket Tracking"
                    : tracking.source === "shopify_live"
                      ? "Live Shopify / Courier Fulfillment"
                      : "Order Database Snapshot"}
                </p>
              </div>

              {tracking.activities.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    Shipment Timeline
                  </h4>
                  <div className="space-y-2 border-l-2 border-border pl-3">
                    {tracking.activities.map((act, i) => (
                      <div key={i} className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-foreground">{act.activity || act.status}</strong>
                          <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                            {act.date}
                          </span>
                        </div>
                        {act.location && (
                          <p className="text-[11px] text-muted-foreground">{act.location}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-5 py-3">
          {displayAwb ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => {
                void navigator.clipboard?.writeText(displayAwb);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
              {copied ? "Copied AWB" : `Copy ${displayAwb}`}
            </Button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {displayUrl && (
              <a
                href={displayUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-95"
              >
                Open Courier Tracking <ExternalLink size={12} />
              </a>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} className="h-8 px-3 text-xs">
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
