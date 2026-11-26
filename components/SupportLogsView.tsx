"use client";

import { ArrowLeft, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "./ui/button";
import { formatShortDate, type ActivityLog } from "../lib/support-ui";

export default function SupportLogsView({
  logs,
  logsLoading,
  onRefresh,
  onBack,
}: {
  logs: ActivityLog[];
  logsLoading: boolean;
  onRefresh: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground">Activity Log</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Recent assignments, replies, and channel sync events
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onRefresh}>
            <RefreshCw size={14} className={logsLoading ? "spin" : ""} /> Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeft size={14} /> Back to Inbox
          </Button>
        </div>
      </div>

      <section className="panel overflow-hidden">
        {logsLoading ? (
          <div className="py-16 text-center text-xs text-muted-foreground">
            Loading activity…
          </div>
        ) : !logs.length ? (
          <div className="py-16 flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
            <RotateCcw size={28} className="opacity-40" />
            <p className="text-xs">No activity recorded yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border max-h-[680px] overflow-y-auto">
            {logs.map((log) => (
              <article
                key={log.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-3 hover:bg-muted/30 transition-colors"
              >
                <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      log.level === "error"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-accent text-accent-foreground"
                    }`}
                  >
                    {log.source}
                  </span>
                  <p className="text-xs sm:text-sm font-medium text-foreground">
                    {log.message}
                  </p>
                </div>
                <time className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatShortDate(log.createdAt)}
                </time>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
