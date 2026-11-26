import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { ensureAuthSchema, withRequestDatabase } from "../lib/database";
import { operationsDb } from "../lib/operations/schema";

const PORT = Number(process.env.LOCAL_PG_PORT || 54321);
const HOST = "127.0.0.1";
const DATA_DIR = path.resolve(process.cwd(), ".local-pgdata");
const DB_URL = `postgresql://postgres:postgres@${HOST}:${PORT}/postgres?sslmode=disable`;

async function seedLocalDatabase() {
  process.env.SUPABASE_DB_URL = DB_URL;
  process.env.SUPPORT_MAILBOX ||= "kritika@satmi.in";

  await withRequestDatabase(async () => {
    const db = await operationsDb();
    await ensureAuthSchema(db);

    const existingTickets = await db
      .prepare("SELECT COUNT(*)::int AS count FROM support_tickets")
      .first<{ count: number }>();

    if ((existingTickets?.count ?? 0) > 0) {
      console.log("✓ Local database already seeded.");
      await db.close();
      return;
    }

    console.log("Bootstrapping local database schema, users, and templates...");

    // 1. Seed Primary Local Admin in auth_users (password hashed with pgcrypto crypt)
    const users = [
      {
        id: "usr_kritika_1",
        email: "kritika@satmi.in",
        password: process.env.LOCAL_ADMIN_PASSWORD || "admin123",
        name: "Kritika Singh",
        role: "admin",
        supportRole: "admin",
      },
    ];

    for (const u of users) {
      await db
        .prepare(
          `INSERT INTO auth_users (id, email, encrypted_password, name, role)
           VALUES (?, ?, crypt(?, gen_salt('bf')), ?, ?)
           ON CONFLICT (email) DO NOTHING`
        )
        .bind(u.id, u.email, u.password, u.name, u.role)
        .run();

      await db
        .prepare(
          `INSERT INTO support_agents (user_id, email, name, role, available)
           VALUES (?, ?, ?, ?, TRUE)
           ON CONFLICT (user_id) DO NOTHING`
        )
        .bind(u.id, u.email, u.name, u.supportRole)
        .run();
    }

    // 2. Ensure Support Mailbox row
    await db
      .prepare(
        `INSERT INTO support_mailboxes (email, encrypted_refresh_token, history_id, import_complete, last_sync_at, last_error, connected_by)
         VALUES (?, '', '', FALSE, NULL, '', 'usr_admin_1')
         ON CONFLICT (email) DO NOTHING`
      )
      .bind("kritika@satmi.in")
      .run();

    // 3. Seed Custom Reply Templates
    await db
      .prepare(
        `INSERT INTO support_reply_templates (id, name, body, created_by, updated_by)
         VALUES
         ('tpl_exchange_1', 'Size Exchange Instructions', 'Hi {{customer_name}},\n\nWe would be happy to help you with a size exchange! Once your order is delivered, please reply here with your preferred size and a photo of the intact product tag, and we will arrange a reverse pickup within 24 hours.\n\nRegards,\nSatmi Support', 'usr_admin_1', 'usr_admin_1'),
         ('tpl_ndr_1', 'Priority NDR Re-attempt Confirmed', 'Hi {{customer_name}},\n\nWe sincerely apologize for the inconvenience caused by the courier partner. We have escalated your AWB on high priority for a mandatory phone-verified delivery re-attempt tomorrow.\n\nRegards,\nSatmi Support', 'usr_admin_1', 'usr_admin_1')
         ON CONFLICT (name) DO NOTHING`
      )
      .run();

    console.log("✓ Local database initialized without test tickets!");
    await db.close();
  });
}

async function main() {
  console.log(`Initializing local PGlite database at ${DATA_DIR} ...`);
  const db = await PGlite.create({
    dataDir: DATA_DIR,
    extensions: { pgcrypto, pg_trgm },
  });
  await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;");

  const server = new PGLiteSocketServer({
    db,
    host: HOST,
    port: PORT,
    maxConnections: 25,
  });

  await server.start();
  console.log(`✓ Local PostgreSQL server listening on ${DB_URL}`);

  await seedLocalDatabase();

  console.log("\n========================================================");
  console.log("Local Customer Support Database Ready!");
  console.log(`Connection URL: ${DB_URL}`);
  console.log("Admin Account: kritika@satmi.in");
  console.log("========================================================\n");

  const shutdown = async () => {
    console.log("\nShutting down local PostgreSQL server...");
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start local database:", err);
  process.exit(1);
});
