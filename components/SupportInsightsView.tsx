"use client";

import { ArrowLeft, RefreshCw, Star } from "lucide-react";
import { Button } from "./ui/button";

export type InsightsData = {
  days: number;
  totalTickets: number;
  resolvedCount: number;
  resolutionRate: number;
  medianFrtMinutes: number | null;
  slaCompliancePercent: number | null;
  avgCsatScore: number | null;
  csatCount: number;
  dailyVolume: Array<{
    day: string;
    email: number;
    facebook: number;
    instagram: number;
  }>;
  agentStats: Array<{
    userId: string;
    name: string;
    email: string;
    role: string;
    available: boolean;
    maxOpenTickets: number;
    preferredChannels: string[];
    openLoad: number;
    resolvedPeriod: number;
    medianFrtMinutes: number | null;
    avgCsat: number | null;
  }>;
};

function formatFrt(mins: number | null) {
  if (mins == null || !Number.isFinite(mins)) return "—";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function SupportInsightsView({
  insights,
  loading,
  days,
  onChangeDays,
  onRefresh,
  onBack,
}: {
  insights: InsightsData | null;
  loading: boolean;
  days: number;
  onChangeDays: (d: number) => void;
  onRefresh: () => void;
  onBack: () => void;
}) {
  const maxDaily = Math.max(
    1,
    ...(insights?.dailyVolume || []).map((d) => d.email + d.facebook + d.instagram),
  );

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            Support Insights
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Channel volume, response SLA health, CSAT feedback, and agent workload balance
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Insights window"
            value={days}
            onChange={(e) => onChangeDays(Number(e.target.value))}
            className="h-8 rounded-lg border border-input bg-card px-2.5 text-xs font-medium text-foreground outline-none focus:border-ring"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={13} className={loading ? "spin" : ""} /> Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeft size={14} /> Back to Inbox
          </Button>
        </div>
      </div>

      {loading && !insights ? (
        <div className="panel py-16 text-center text-xs text-muted-foreground">
          Loading support insights…
        </div>
      ) : !insights ? (
        <div className="panel py-16 text-center text-xs text-muted-foreground">
          No insights data available yet.
        </div>
      ) : (
        <>
          {/* Core Metrics Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="panel p-4">
              <span className="text-[11px] font-medium text-muted-foreground">
                Volume ({insights.days}d)
              </span>
              <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">
                {insights.totalTickets}
              </p>
              <span className="text-[10px] text-muted-foreground">
                {insights.resolvedCount} resolved
              </span>
            </div>

            <div className="panel p-4">
              <span className="text-[11px] font-medium text-muted-foreground">
                Resolution Rate
              </span>
              <p className="mt-1 text-2xl font-bold tracking-tight text-success">
                {insights.resolutionRate}%
              </p>
              <span className="text-[10px] text-muted-foreground">Closed of total</span>
            </div>

            <div className="panel p-4">
              <span className="text-[11px] font-medium text-muted-foreground">
                Median First Reply
              </span>
              <p className="mt-1 text-2xl font-bold tracking-tight text-primary">
                {formatFrt(insights.medianFrtMinutes)}
              </p>
              <span className="text-[10px] text-muted-foreground">Inbound to first reply</span>
            </div>

            <div className="panel p-4">
              <span className="text-[11px] font-medium text-muted-foreground">
                SLA Compliance
              </span>
              <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">
                {insights.slaCompliancePercent != null ? `${insights.slaCompliancePercent}%` : "—"}
              </p>
              <span className="text-[10px] text-muted-foreground">Replied within target</span>
            </div>

            <div className="panel p-4 col-span-2 sm:col-span-1">
              <span className="text-[11px] font-medium text-muted-foreground">CSAT Score</span>
              <p className="mt-1 text-2xl font-bold tracking-tight text-amber-500 flex items-center gap-1">
                {insights.avgCsatScore != null ? (
                  <>
                    <Star size={18} className="fill-amber-400 text-amber-400" />
                    {insights.avgCsatScore}
                  </>
                ) : (
                  "—"
                )}
              </p>
              <span className="text-[10px] text-muted-foreground">
                {insights.csatCount} rating{insights.csatCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* Daily Volume by Channel */}
          <section className="panel p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Daily Volume by Channel</h2>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-blue-500" /> Facebook
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-pink-500" /> Instagram
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-primary" /> Email
                </span>
              </div>
            </div>

            {insights.dailyVolume.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                No tickets created in this date window.
              </p>
            ) : (
              <div className="flex items-end gap-2 h-40 pt-4 overflow-x-auto pb-1">
                {insights.dailyVolume.map((d) => {
                  const total = d.email + d.facebook + d.instagram;
                  const heightPct = Math.max(8, Math.round((total / maxDaily) * 100));
                  const fbPct = total ? (d.facebook / total) * 100 : 0;
                  const igPct = total ? (d.instagram / total) * 100 : 0;
                  const emPct = total ? (d.email / total) * 100 : 0;
                  const shortDate = d.day.slice(5);

                  return (
                    <div
                      key={d.day}
                      className="flex flex-col items-center gap-1.5 min-w-[34px] flex-1"
                      title={`${d.day}: ${total} total (FB ${d.facebook}, IG ${d.instagram}, Email ${d.email})`}
                    >
                      <span className="text-[10px] font-mono text-muted-foreground">{total}</span>
                      <div className="w-full max-w-[26px] h-24 rounded-md bg-muted/40 flex items-end overflow-hidden">
                        <div
                          className="w-full flex flex-col justify-end rounded-t-md overflow-hidden"
                          style={{ height: `${heightPct}%` }}
                        >
                          {emPct > 0 && (
                            <div className="bg-primary w-full" style={{ height: `${emPct}%` }} />
                          )}
                          {igPct > 0 && (
                            <div className="bg-pink-500 w-full" style={{ height: `${igPct}%` }} />
                          )}
                          {fbPct > 0 && (
                            <div className="bg-blue-500 w-full" style={{ height: `${fbPct}%` }} />
                          )}
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground">{shortDate}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Per-Agent Workload Table */}
          <section className="panel overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Per-Agent Workload &amp; SLA</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse min-w-[680px]">
                <thead className="bg-muted/60 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="px-4 py-2.5">Agent</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Active Capacity</th>
                    <th className="px-4 py-2.5">Channels</th>
                    <th className="px-4 py-2.5">Resolved ({insights.days}d)</th>
                    <th className="px-4 py-2.5">Median FRT</th>
                    <th className="px-4 py-2.5">CSAT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {insights.agentStats.map((a) => {
                    const pct = Math.min(
                      100,
                      Math.round((a.openLoad / Math.max(1, a.maxOpenTickets)) * 100),
                    );
                    return (
                      <tr key={a.userId} className="hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <strong className="block font-semibold text-foreground">{a.name}</strong>
                          <span className="text-[11px] text-muted-foreground">{a.email}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              a.available
                                ? "bg-success/15 text-success"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {a.available ? "Available" : "Away"}
                          </span>
                        </td>
                        <td className="px-4 py-3 min-w-[140px]">
                          <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                            <span>
                              {a.openLoad} / {a.maxOpenTickets}
                            </span>
                            <span>{pct}%</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                pct >= 90 ? "bg-destructive" : "bg-primary"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {a.preferredChannels.map((ch) => (
                              <span
                                key={ch}
                                className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] capitalize"
                              >
                                {ch}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono font-semibold">{a.resolvedPeriod}</td>
                        <td className="px-4 py-3 font-mono">{formatFrt(a.medianFrtMinutes)}</td>
                        <td className="px-4 py-3 font-mono">
                          {a.avgCsat != null ? `★ ${a.avgCsat}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
