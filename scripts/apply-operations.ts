import { operationsDb } from "../lib/operations/schema";
try {
  const db = await operationsDb();
  const { results } = await db
    .prepare(
      "SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('support_mailboxes','support_agents','support_tickets','support_messages','support_events','support_reply_templates') ORDER BY tablename"
    )
    .all();
  console.log(JSON.stringify({ ok: true, security: results }));
} catch (e) {
  console.error(
    "Could not apply customer support schema:",
    e instanceof Error ? e.message : "Database unavailable"
  );
  process.exitCode = 1;
}
