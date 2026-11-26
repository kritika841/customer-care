"use client";

import { useEffect, useState } from "react";
import { readJson } from "../lib/http";

type Status = {
  state: string;
  lastSyncAt?: string;
  lastEventAt?: string;
  pending?: number;
  historyPending?: boolean;
};

export default function LiveStatus({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<Status>({ state: "checking" });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let inFlight = false;
    async function poll() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        setStatus(
          await readJson<Status>(
            await fetch("/api/health/sync", {
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22000)]),
            })
          )
        );
      } catch {
        if (!controller.signal.aborted) setStatus({ state: "offline" });
      } finally {
        inFlight = false;
      }
    }
    void poll();
    const id = setInterval(poll, 15000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [active]);

  const label =
    {
      healthy: "Up to date",
      syncing: "Syncing",
      stale: "Sync delayed",
      offline: "Offline",
      checking: "Connecting",
    }[status.state] || "Sync delayed";

  const displayLabel =
    status.historyPending && ["healthy", "syncing"].includes(status.state)
      ? "Syncing history"
      : label;

  const dotColor =
    {
      healthy: "bg-success shadow-[0_0_8px_rgba(25,138,83,0.5)]",
      syncing: "bg-primary animate-pulse",
      stale: "bg-warning",
      offline: "bg-muted-foreground",
      checking: "bg-primary/50 animate-pulse",
    }[status.state] || "bg-warning";

  return (
    <span
      className="hidden sm:inline-flex items-center gap-2 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors whitespace-nowrap"
      role="status"
      title={`Last sync: ${
        status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString("en-IN") : "Unavailable"
      }${status.pending ? ` · ${status.pending} pending events` : ""}`}
    >
      <span className={`inline-block size-2 rounded-full ${dotColor}`} />
      <span>{displayLabel}</span>
    </span>
  );
}
