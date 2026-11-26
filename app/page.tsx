import SupportDashboard from "./SupportDashboard";
import { isAdmin, isSupportManager, requirePageUser } from "../lib/auth/access";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ view?: string; q?: string }>;
}) {
  const user = await requirePageUser();
  const params = (await searchParams) || {};
  const admin = isAdmin(user);
  const canManage = isSupportManager(user);
  const initialView =
    params.view === "queue"
      ? "queue"
      : canManage && params.view === "ai"
        ? "ai"
        : canManage && params.view === "insights"
          ? "insights"
          : canManage && params.view === "settings"
            ? "settings"
            : canManage && params.view === "logs"
              ? "logs"
              : canManage
                ? "tickets"
                : "queue";

  return (
    <SupportDashboard
      userLabel={user.name}
      userEmail={user.email}
      userRole={user.role}
      isAdmin={admin}
      initialView={initialView}
      initialQuery={typeof params.q === "string" ? params.q : ""}
    />
  );
}
