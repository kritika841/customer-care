"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail, RefreshCw, Sparkles, Tag, Users, UsersRound } from "lucide-react";
import { Button } from "./ui/button";
import { readJson, requestErrorMessage } from "../lib/http";
import type { Data } from "../lib/support-ui";

export default function SupportSettingsView({
  data,
  isAdmin,
  userRole,
  busy,
  ticketPlural,
  onBack,
  onAct,
  onRefresh,
  onError,
  onNotice,
}: {
  data: Data;
  isAdmin: boolean;
  userRole: string;
  busy: boolean;
  ticketPlural: string;
  onBack: () => void;
  onAct: (action: string, b?: Record<string, unknown>) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}) {
  const [nomenclatureDraft, setNomenclatureDraft] = useState<{
    singular: string;
    plural: string;
  } | null>(null);
  const [nomenclatureSaving, setNomenclatureSaving] = useState(false);
  const [metaTokenDraft, setMetaTokenDraft] = useState("");

  const ticketSingular =
    String((data.aiSettings as { ticketLabelSingular?: string } | undefined)?.ticketLabelSingular || "Ticket").trim() || "Ticket";
  const nomenclatureSingular = nomenclatureDraft?.singular ?? ticketSingular;
  const nomenclaturePlural = nomenclatureDraft?.plural ?? ticketPlural;

  const fb = (data.socialConnections || []).find((c) => c.channel === "facebook");
  const ig = (data.socialConnections || []).find((c) => c.channel === "instagram");
  const adminAccess = isAdmin || userRole.split(",").map((r) => r.trim()).includes("admin");

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            Settings &amp; Channels
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure workspace nomenclature, support agents, and connected customer channels.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> Back to {ticketPlural}
        </Button>
      </div>

      {/* Admin-Only Ticketing Nomenclature Card */}
      {adminAccess && (
        <article className="panel p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                <Tag size={19} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  Ticketing Nomenclature (Admin)
                </h2>
                <p className="text-xs text-muted-foreground">
                  Rename &ldquo;Ticket&rdquo; / &ldquo;Tickets&rdquo; across the entire dashboard (e.g., Case / Cases, Inquiry / Inquiries).
                </p>
              </div>
            </div>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setNomenclatureSaving(true);
              onError("");
              onNotice("");
              try {
                const res = await readJson<{ notice?: string }>(
                  await fetch("/api/support", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "nomenclature_update",
                      ticketLabelSingular: nomenclatureSingular,
                      ticketLabelPlural: nomenclaturePlural,
                    }),
                  }),
                );
                await onRefresh();
                setNomenclatureDraft(null);
                if (res.notice) onNotice(res.notice);
              } catch (err) {
                onError(requestErrorMessage(err));
              } finally {
                setNomenclatureSaving(false);
              }
            }}
            className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
          >
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Singular Label
              </span>
              <input
                type="text"
                maxLength={32}
                required
                value={nomenclatureSingular}
                onChange={(e) =>
                  setNomenclatureDraft({
                    singular: e.target.value,
                    plural: nomenclaturePlural,
                  })
                }
                placeholder="Ticket"
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-xs font-medium text-foreground outline-none focus:border-ring"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Plural Label
              </span>
              <input
                type="text"
                maxLength={32}
                required
                value={nomenclaturePlural}
                onChange={(e) =>
                  setNomenclatureDraft({
                    singular: nomenclatureSingular,
                    plural: e.target.value,
                  })
                }
                placeholder="Tickets"
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-xs font-medium text-foreground outline-none focus:border-ring"
              />
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={
                  nomenclatureSaving || !nomenclatureSingular.trim() || !nomenclaturePlural.trim()
                }
                className="h-9 px-4 text-xs"
              >
                {nomenclatureSaving ? "Saving…" : "Save Nomenclature"}
              </Button>
            </div>
          </form>
        </article>
      )}

      {/* Support Team Card */}
      <article className="panel p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Users size={19} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Support Agents ({data.agents.length})
              </h2>
              <p className="text-xs text-muted-foreground">
                Incoming queries automatically assign to the available agent with the fewest open tickets.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onAct("team")}
            >
              <RefreshCw size={14} /> Sync agents
            </Button>
            {adminAccess && (
              <Link
                href="/admin/users"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted transition"
              >
                <UsersRound size={14} /> Manage Users
              </Link>
            )}
          </div>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
          {data.agents.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No support agents synced yet.
            </div>
          ) : (
            data.agents.map((a) => {
              const prefs = Array.isArray(a.preferred_channels)
                ? (a.preferred_channels as string[])
                : ["email", "instagram", "facebook"];
              const maxCap = Number(a.max_open_tickets || 25);
              const openLoad = Number(a.open_load || 0);

              return (
                <div
                  key={a.user_id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-card hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-[200px]">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground text-xs font-bold">
                      {String(a.name || a.email || "A")
                        .slice(0, 2)
                        .toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <strong className="block text-sm font-semibold text-foreground truncate">
                        {a.name}
                      </strong>
                      <small className="block text-xs text-muted-foreground truncate">
                        {a.email} · {String(a.role || "").replaceAll("_", " ")} · Load:{" "}
                        <span className="font-mono text-foreground font-semibold">
                          {openLoad}/{maxCap}
                        </span>
                      </small>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-1" title="Preferred channel routing">
                      {(["email", "instagram", "facebook"] as const).map((ch) => {
                        const on = prefs.includes(ch);
                        return (
                          <button
                            key={ch}
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              const next = on
                                ? prefs.filter((p) => p !== ch)
                                : [...prefs, ch];
                              if (!next.length) return;
                              void onAct("agent_settings", {
                                agentId: a.user_id,
                                maxOpenTickets: maxCap,
                                preferredChannels: next,
                              });
                            }}
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize transition cursor-pointer ${
                              on
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-border bg-muted/40 text-muted-foreground opacity-60 hover:opacity-100"
                            }`}
                          >
                            {ch === "instagram" ? "IG" : ch === "facebook" ? "FB" : "Email"}
                          </button>
                        );
                      })}
                    </div>

                    <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>Max</span>
                      <input
                        type="number"
                        min={1}
                        max={200}
                        defaultValue={maxCap}
                        disabled={busy}
                        aria-label={`Max open tickets for ${a.name}`}
                        onBlur={(e) => {
                          const nextVal = Math.max(1, Math.min(200, Number(e.target.value || maxCap)));
                          if (nextVal !== maxCap) {
                            void onAct("agent_settings", {
                              agentId: a.user_id,
                              maxOpenTickets: nextVal,
                              preferredChannels: prefs,
                            });
                          }
                        }}
                        className="h-7 w-14 rounded-lg border border-input bg-background px-2 text-xs font-mono text-foreground outline-none focus:border-ring"
                      />
                    </label>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onAct("availability", {
                          agentId: a.user_id,
                          available: !a.available,
                        })
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer disabled:opacity-50 ${
                        a.available
                          ? "border-success/30 bg-success/15 text-success hover:bg-success/20"
                          : "border-border bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          a.available ? "bg-success" : "bg-muted-foreground"
                        }`}
                      />
                      {a.available ? "Available" : "Away"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </article>

      {/* Connected Channels Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <article className="panel p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                <Mail size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Email (Gmail)</h3>
                <p className="text-xs text-muted-foreground">{data.connection.email}</p>
              </div>
            </div>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                data.connection.connected
                  ? "bg-success/15 text-success"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              }`}
            >
              {data.connection.connected ? "Connected" : "Setup needed"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {adminAccess && data.configured && (
              <a
                className="inline-flex h-8 items-center justify-center rounded-lg border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                href="/api/support/gmail/connect"
              >
                {data.connection.connected ? "Reconnect Gmail" : "Connect Gmail"}
              </a>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onAct("sync")}
            >
              <RefreshCw size={13} className={busy ? "spin" : ""} /> Sync Now
            </Button>
          </div>
        </article>

        <article className="panel p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-foreground border border-border">
                <Sparkles size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Facebook &amp; Instagram DMs
                </h3>
                <p className="text-xs text-muted-foreground">
                  {[
                    fb?.connected ? `FB: ${fb.account_name}` : "FB offline",
                    ig?.connected ? `IG: ${ig.username}` : "IG offline",
                  ].join(" · ")}
                </p>
              </div>
            </div>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                fb?.connected || ig?.connected
                  ? "bg-success/15 text-success"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              }`}
            >
              {fb?.connected || ig?.connected ? "Connected" : "Setup needed"}
            </span>
          </div>

          {(fb?.last_error || ig?.last_error) && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300 space-y-0.5">
              {fb?.last_error && <div>FB: {String(fb.last_error)}</div>}
              {ig?.last_error && <div>IG: {String(ig.last_error)}</div>}
            </div>
          )}

          {adminAccess && (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium text-primary hover:underline">
                Token &amp; reconnection settings
              </summary>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const tokenToUse = metaTokenDraft.trim();
                  if (!tokenToUse && !data.metaSystemConfigured) return;
                  if (
                    await onAct(
                      "meta_connect",
                      tokenToUse ? { accessToken: tokenToUse } : {},
                    )
                  ) {
                    setMetaTokenDraft("");
                  }
                }}
                className="mt-3 space-y-2.5 pt-2.5 border-t border-border/60"
              >
                <input
                  type="password"
                  value={metaTokenDraft}
                  onChange={(e) => setMetaTokenDraft(e.target.value)}
                  placeholder={
                    data.metaSystemConfigured
                      ? "Optional: override System User Token (EAA…)"
                      : "Paste Meta System User Token (EAA…)"
                  }
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={busy || (!metaTokenDraft.trim() && !data.metaSystemConfigured)}
                >
                  {data.metaSystemConfigured && !metaTokenDraft.trim()
                    ? "Reconnect via System Token"
                    : "Save & Connect Meta"}
                </Button>
              </form>
            </details>
          )}
        </article>
      </div>
    </div>
  );
}
