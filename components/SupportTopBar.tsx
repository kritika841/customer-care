"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Menu, Plus, RefreshCw, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import AccountMenu from "../app/AccountMenu";
import { Button } from "./ui/button";
import type { TicketNomenclature } from "./SupportSidebar";

export type { TicketNomenclature };
export type TopNavSection = "tickets" | "queue" | "ai" | "insights" | "settings" | "logs" | "users";

export default function SupportTopBar({
  canManage,
  isAdmin,
  userLabel,
  userEmail,
  nomenclature = { singular: "Ticket", plural: "Tickets" },
  searchValue,
  onSearchChange,
  onOpenMobileMenu,
  onOpenNewTicket,
  onSync,
  busy = false,
  approvalModeEnabled,
  confidenceThresholdPercent,
  onToggleApprovalMode,
}: {
  activeNav?: TopNavSection;
  canManage: boolean;
  isAdmin: boolean;
  userLabel: string;
  userEmail: string;
  nomenclature?: TicketNomenclature;
  searchValue?: string;
  onSearchChange?: (next: string) => void;
  onSelectView?: (view: "tickets" | "queue" | "ai" | "insights" | "settings" | "logs") => void;
  onOpenMobileMenu?: () => void;
  onOpenNewTicket?: () => void;
  onSync?: () => void;
  busy?: boolean;
  approvalModeEnabled?: boolean;
  confidenceThresholdPercent?: number;
  onToggleApprovalMode?: () => void;
}) {
  const singularLabel = nomenclature.singular.trim() || "Ticket";
  const pluralLabel = nomenclature.plural.trim() || "Tickets";
  const router = useRouter();
  const [localSearch, setLocalSearch] = useState("");
  const isControlledSearch = typeof onSearchChange === "function";
  const currentSearch = isControlledSearch ? (searchValue ?? "") : localSearch;

  const handleSearchInput = (next: string) => {
    if (onSearchChange) {
      onSearchChange(next);
    } else {
      setLocalSearch(next);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isControlledSearch) {
      const q = localSearch.trim();
      router.push(q ? `/?q=${encodeURIComponent(q)}` : "/");
    }
  };

  return (
    <header className="sticky top-0 z-20 h-14 border-b border-border/90 bg-card/95 backdrop-blur shrink-0">
      <div className="flex h-full items-center justify-between gap-3 px-4 sm:px-6">
        {/* Left: Mobile Menu Button + Search Bar */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          {onOpenMobileMenu && (
            <button
              type="button"
              onClick={onOpenMobileMenu}
              aria-label="Open navigation menu"
              className="lg:hidden flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground hover:bg-muted cursor-pointer"
            >
              <Menu size={17} />
            </button>
          )}

          <form
            onSubmit={handleSearchSubmit}
            className="relative flex items-center flex-1 max-w-md min-w-0"
          >
            <Search size={14} className="absolute left-3 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={currentSearch}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder={
                canManage
                  ? `Search customer, order, ${singularLabel.toLowerCase()} #…`
                  : `Search your ${pluralLabel.toLowerCase()}…`
              }
              className="h-9 w-full rounded-full border border-input bg-muted/40 pl-9 pr-8 text-xs text-foreground placeholder:text-muted-foreground outline-none transition focus:bg-background focus:border-ring focus:ring-2 focus:ring-ring/20"
            />
            {currentSearch && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => handleSearchInput("")}
                className="absolute right-2.5 flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
              >
                <X size={13} />
              </button>
            )}
          </form>
        </div>

        {/* Right: Approval Mode Toggle + Utilities */}
        <div className="flex items-center gap-2 shrink-0">
          {canManage && typeof approvalModeEnabled === "boolean" && onToggleApprovalMode && (
            <button
              type="button"
              role="switch"
              aria-checked={approvalModeEnabled}
              disabled={busy}
              onClick={onToggleApprovalMode}
              title={
                approvalModeEnabled
                  ? "Approval Mode ON: AI replies appear in the review table for Approve/Decline before sending."
                  : `Auto-Send Mode ON: AI automatically sends replies with confidence >= ${confidenceThresholdPercent ?? 82}%.`
              }
              className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[11px] font-semibold transition cursor-pointer disabled:opacity-50 ${
                approvalModeEnabled
                  ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                  : "border-success/40 bg-success/15 text-success hover:bg-success/20"
              }`}
            >
              {approvalModeEnabled ? <ShieldCheck size={13} /> : <Sparkles size={13} />}
              <span className="hidden md:inline">
                {approvalModeEnabled
                  ? "Approval Mode: ON"
                  : `Auto-Send: ON (≥${confidenceThresholdPercent ?? 82}%)`}
              </span>
              <span className="md:hidden">{approvalModeEnabled ? "Approve" : "Auto"}</span>
              <span
                className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                  approvalModeEnabled ? "bg-primary" : "bg-success"
                }`}
              >
                <span
                  className={`inline-block size-3 rounded-full bg-white shadow-xs transition-transform ${
                    approvalModeEnabled ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          )}

          {canManage && (
            <Button
              variant="primary"
              size="sm"
              onClick={onOpenNewTicket || (() => router.push("/?new=1"))}
              className="h-8 px-2.5 text-xs"
            >
              <Plus size={14} />
              <span className="hidden sm:inline">New {singularLabel}</span>
            </Button>
          )}

          {canManage && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              title="Sync last 30 days of DMs & Email"
              onClick={onSync || (() => router.push("/"))}
              className="h-8 px-2.5 text-xs"
            >
              <RefreshCw size={13} className={busy ? "spin" : ""} />
              <span className="hidden sm:inline">Sync</span>
            </Button>
          )}

          <ThemeToggle />
          <AccountMenu name={userLabel} email={userEmail} isAdmin={isAdmin} />
        </div>
      </div>
    </header>
  );
}
