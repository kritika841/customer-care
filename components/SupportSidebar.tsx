"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Inbox,
  MessageSquareWarning,
  Settings,
  Sparkles,
  Users,
  X,
} from "lucide-react";

export type SidebarNavSection =
  | "tickets"
  | "queue"
  | "ai"
  | "insights"
  | "settings"
  | "logs"
  | "users";

export type TicketNomenclature = {
  singular: string;
  plural: string;
};

export default function SupportSidebar({
  activeNav,
  canManage,
  isAdmin,
  nomenclature = { singular: "Ticket", plural: "Tickets" },
  openCount = 0,
  humanQueueCount = 0,
  mobileOpen = false,
  onCloseMobile,
  onSelectView,
}: {
  activeNav: SidebarNavSection;
  canManage: boolean;
  isAdmin: boolean;
  nomenclature?: TicketNomenclature;
  openCount?: number;
  humanQueueCount?: number;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  onSelectView?: (view: "tickets" | "queue" | "ai" | "insights" | "settings" | "logs") => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pluralLabel = nomenclature.plural.trim() || "Tickets";

  const items: Array<{
    key: SidebarNavSection;
    label: string;
    href: string;
    icon: React.ReactNode;
    badge?: number;
    badgeTone?: "amber" | "default";
    show: boolean;
  }> = [
    {
      key: "tickets",
      label: pluralLabel,
      href: "/",
      icon: <Inbox size={17} className="shrink-0" />,
      badge: openCount > 0 ? openCount : undefined,
      badgeTone: "default",
      show: true,
    },
    {
      key: "queue",
      label: "Agent Queue",
      href: "/?view=queue",
      icon: <MessageSquareWarning size={17} className="shrink-0" />,
      badge: humanQueueCount > 0 ? humanQueueCount : undefined,
      badgeTone: "amber",
      show: true,
    },
    {
      key: "ai",
      label: "AI & Memory",
      href: "/?view=ai",
      icon: <Sparkles size={17} className="shrink-0" />,
      show: canManage,
    },
    {
      key: "insights",
      label: "Insights",
      href: "/?view=insights",
      icon: <BarChart3 size={17} className="shrink-0" />,
      show: canManage,
    },
    {
      key: "settings",
      label: "Settings",
      href: "/?view=settings",
      icon: <Settings size={17} className="shrink-0" />,
      show: canManage,
    },
    {
      key: "logs",
      label: "Activity",
      href: "/?view=logs",
      icon: <Activity size={17} className="shrink-0" />,
      show: canManage,
    },
    {
      key: "users",
      label: "Users",
      href: "/admin/users",
      icon: <Users size={17} className="shrink-0" />,
      show: isAdmin,
    },
  ];

  const renderNavBody = (isMobile = false) => {
    const isCollapsed = !isMobile && collapsed;

    return (
      <div className="flex h-full flex-col bg-card border-r border-border select-none">
        {/* Brand Header */}
        <div
          className={`flex h-14 items-center border-b border-border px-3 ${
            isCollapsed ? "justify-center" : "justify-between"
          }`}
        >
          {onSelectView ? (
            <button
              type="button"
              onClick={() => {
                onSelectView("tickets");
                onCloseMobile?.();
              }}
              className="flex items-center gap-2.5 min-w-0 cursor-pointer text-left"
              title="Satmi Support"
            >
              <Image
                src="/logo-light.png"
                alt="Satmi"
                width={266}
                height={113}
                priority
                className={`${isCollapsed ? "h-5 max-w-[36px]" : "h-6 max-w-[96px]"} w-auto object-contain dark:hidden`}
              />
              <Image
                src="/logo-dark.png"
                alt="Satmi"
                width={266}
                height={113}
                priority
                className={`hidden ${isCollapsed ? "h-5 max-w-[36px]" : "h-6 max-w-[96px]"} w-auto object-contain dark:block`}
              />
              {!isCollapsed && (
                <span className="text-xs font-semibold tracking-tight text-muted-foreground border-l border-border pl-2">
                  Support
                </span>
              )}
            </button>
          ) : (
            <Link
              href="/"
              onClick={() => onCloseMobile?.()}
              className="flex items-center gap-2.5 min-w-0 text-left"
            >
              <Image
                src="/logo-light.png"
                alt="Satmi"
                width={266}
                height={113}
                priority
                className={`${isCollapsed ? "h-5 max-w-[36px]" : "h-6 max-w-[96px]"} w-auto object-contain dark:hidden`}
              />
              <Image
                src="/logo-dark.png"
                alt="Satmi"
                width={266}
                height={113}
                priority
                className={`hidden ${isCollapsed ? "h-5 max-w-[36px]" : "h-6 max-w-[96px]"} w-auto object-contain dark:block`}
              />
              {!isCollapsed && (
                <span className="text-xs font-semibold tracking-tight text-muted-foreground border-l border-border pl-2">
                  Support
                </span>
              )}
            </Link>
          )}

          {isMobile ? (
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            >
              <X size={16} />
            </button>
          ) : (
            !isCollapsed && (
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
              >
                <ChevronLeft size={15} />
              </button>
            )
          )}
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-1" aria-label="Main navigation">
          {items
            .filter((item) => item.show)
            .map((item) => {
              const isActive = activeNav === item.key;
              const baseCls = `group flex w-full items-center ${
                isCollapsed ? "justify-center px-2" : "justify-between px-3"
              } py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                isActive
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`;

              const inner = (
                <>
                  <span className="flex items-center gap-2.5 min-w-0">
                    {item.icon}
                    {!isCollapsed && <span className="truncate">{item.label}</span>}
                  </span>
                  {!isCollapsed && item.badge !== undefined && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-mono font-bold ${
                        isActive
                          ? "bg-white/20 text-primary-foreground"
                          : item.badgeTone === "amber"
                            ? "bg-amber-500/20 text-amber-800 dark:text-amber-300"
                            : "bg-muted text-foreground"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </>
              );

              if (item.key !== "users" && onSelectView) {
                return (
                  <button
                    key={item.key}
                    type="button"
                    title={isCollapsed ? item.label : undefined}
                    onClick={() => {
                      onSelectView(
                        item.key as "tickets" | "queue" | "ai" | "insights" | "settings" | "logs",
                      );
                      onCloseMobile?.();
                    }}
                    className={baseCls}
                  >
                    {inner}
                  </button>
                );
              }

              return (
                <Link
                  key={item.key}
                  href={item.href}
                  title={isCollapsed ? item.label : undefined}
                  onClick={() => onCloseMobile?.()}
                  className={baseCls}
                >
                  {inner}
                </Link>
              );
            })}
        </nav>

        {/* Expand Footer Toggle when collapsed */}
        {!isMobile && isCollapsed && (
          <div className="border-t border-border p-2 flex justify-center">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Desktop Sticky Left Sidebar */}
      <aside
        className={`hidden lg:block shrink-0 sticky top-0 h-screen transition-all duration-150 z-30 ${
          collapsed ? "w-16" : "w-56"
        }`}
      >
        {renderNavBody(false)}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onCloseMobile}
            className="fixed inset-0 bg-black/50 backdrop-blur-[1px] cursor-default"
          />
          <aside className="relative z-10 w-64 max-w-[80vw] h-full shadow-float">
            {renderNavBody(true)}
          </aside>
        </div>
      )}
    </>
  );
}
