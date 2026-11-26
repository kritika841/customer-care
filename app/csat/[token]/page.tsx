import Image from "next/image";
import ThemeToggle from "../../../components/ThemeToggle";
import { withRequestDatabase } from "../../../lib/database";
import { getCsatContext } from "../../../lib/operations/support";
import CsatForm from "./CsatForm";

export const dynamic = "force-dynamic";

export default async function CsatPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ticket = await withRequestDatabase(() => getCsatContext(token), 15000).catch(() => null);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Image
              src="/logo-light.png"
              alt="Satmi"
              width={266}
              height={113}
              priority
              className="h-7 w-auto max-w-[112px] object-contain dark:hidden"
            />
            <Image
              src="/logo-dark.png"
              alt="Satmi"
              width={266}
              height={113}
              priority
              className="hidden h-7 w-auto max-w-[112px] object-contain dark:block"
            />
            <span className="h-5 w-px bg-border" />
            <span className="text-sm font-semibold text-foreground">Customer Feedback</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-lg">
          {ticket ? (
            <CsatForm
              token={token}
              ticketNumber={String(ticket.ticket_number || "")}
              customerName={String(ticket.customer_name || "")}
              initialScore={ticket.csat_score != null ? Number(ticket.csat_score) : null}
              initialComment={String(ticket.csat_comment || "")}
            />
          ) : (
            <div className="panel p-8 text-center space-y-2">
              <h1 className="text-lg font-bold text-foreground">Feedback link expired or invalid</h1>
              <p className="text-xs text-muted-foreground">
                This support rating link could not be found. Please reply directly to your Satmi
                support conversation if you still need assistance.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
