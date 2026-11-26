import { requirePageAdmin } from "../../../lib/auth/access";
import { getAiSettings } from "../../../lib/operations/ai-agent";
import AdminUsers from "./AdminUsers";
import SupportTopBar from "../../../components/SupportTopBar";
import SupportSidebar from "../../../components/SupportSidebar";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const [user, settings] = await Promise.all([
    requirePageAdmin(),
    getAiSettings().catch(() => null),
  ]);
  const nomenclature = {
    singular: settings?.ticketLabelSingular || "Ticket",
    plural: settings?.ticketLabelPlural || "Tickets",
  };
  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <SupportSidebar
        activeNav="users"
        canManage={true}
        isAdmin={true}
        nomenclature={nomenclature}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <SupportTopBar
          activeNav="users"
          canManage={true}
          isAdmin={true}
          userLabel={user.name}
          userEmail={user.email}
          nomenclature={nomenclature}
        />

        <main className="flex-1">
          <div className="mx-auto w-full max-w-[1640px] px-4 sm:px-6 py-5">
            <div className="max-w-5xl mx-auto">
              <AdminUsers currentUserId={user.id} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
