"use client";

import SupportPanel from "./SupportPanel";

export default function SupportDashboard({
  userLabel,
  userEmail,
  userRole,
  isAdmin,
  initialView = "tickets",
  initialQuery = "",
}: {
  userLabel: string;
  userEmail: string;
  userRole: string;
  isAdmin: boolean;
  initialView?: "tickets" | "queue" | "ai" | "insights" | "settings" | "logs";
  initialQuery?: string;
}) {
  return (
    <SupportPanel
      active={true}
      isAdmin={isAdmin}
      userLabel={userLabel}
      userEmail={userEmail}
      userRole={userRole}
      initialView={initialView}
      initialQuery={initialQuery}
    />
  );
}
