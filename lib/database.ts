import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { supabaseCA } from "./certs/supabase-ca";
import { orderTagFunctionsSql } from "./order-tag-schema";
import { transactionQueries } from "./postgres-transaction";

type Row = Record<string, unknown>;

const resultKeyAliases: Record<string, string> = {
  orderid: "orderId",
  userid: "userId",
  confirmationassigneeid: "confirmationAssigneeId",
  confirmationassigneename: "confirmationAssigneeName",
  rejectionreason: "rejectionReason",
  confirmationnote: "confirmationNote",
  lowapproved: "lowApproved",
  channelorderid: "channelOrderId",
  channelname: "channelName",
  customername: "customerName",
  customeremail: "customerEmail",
  customerphone: "customerPhone",
  customercity: "customerCity",
  customerstate: "customerState",
  orderdate: "orderDate",
  createdat: "createdAt",
  updatedat: "updatedAt",
  deliveredat: "deliveredAt",
  shippedat: "shippedAt",
  outfordeliveryat: "outForDeliveryAt",
  firstoutfordeliveryat: "firstOutForDeliveryAt",
  paymentmethod: "paymentMethod",
  paymentstatus: "paymentStatus",
  shippingcost: "shippingCost",
  pickuplocation: "pickupLocation",
  shipmentid: "shipmentId",
  productsjson: "productsJson",
  rawjson: "rawJson",
  syncedat: "syncedAt",
  eventtype: "eventType",
  detailsjson: "detailsJson",
  fieldsjson: "fieldsJson",
  changesjson: "changesJson",
  eventat: "eventAt",
  confirmationstatus: "confirmationStatus",
  confirmationupdatedat: "confirmationUpdatedAt",
  confirmedat: "confirmedAt",
  rejectedat: "rejectedAt",
};

function normalizeRows(rows: Row[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [resultKeyAliases[key] || key, value])
    )
  );
}

export type QueryResult<T> = { results: T[] };

function postgresPlaceholders(query: string, count?: number) {
  if (count === 0) return query;
  let position = 0;
  return query.replace(/\?/g, (match) =>
    count !== undefined && position >= count ? match : `$${++position}`
  );
}

export class PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly query: (text: string, values: unknown[]) => Promise<Row[]>,
    private readonly text: string
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  toQuery() {
    return { text: postgresPlaceholders(this.text, this.values.length), values: this.values };
  }

  async all<T>(): Promise<QueryResult<T>> {
    return { results: (await this.query(this.text, this.values)) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return ((await this.query(this.text, this.values))[0] as T | undefined) ?? null;
  }

  async run() {
    return { success: true, results: await this.query(this.text, this.values) };
  }
}

export class PostgresDatabase {
  private readonly pool: Pool;
  private readonly clients = new Set<PoolClient>();

  constructor(
    connectionString: string,
    private readonly onClose?: () => void,
  ) {
    const url = new URL(connectionString);
    const supabase = url.hostname.endsWith(".supabase.com") || url.hostname.endsWith(".supabase.co");
    const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (supabase) url.searchParams.delete("sslmode");
    this.pool = new Pool({
      connectionString: url.toString(),
      ...(supabase ? { ssl: { ca: supabaseCA, rejectUnauthorized: true } } : {}),
      max: isLocal ? 4 : 10,
      connectionTimeoutMillis: isLocal ? 15000 : 5000,
      idleTimeoutMillis: 30000,
      query_timeout: 15000,
      statement_timeout: 15000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 20000,
      application_name: "satmi-support",
    });
    this.pool.on("connect", (client) => this.clients.add(client));
    this.pool.on("remove", (client) => this.clients.delete(client));
    this.pool.on("error", (error) =>
      console.error("Idle database connection failed", { code: (error as { code?: string }).code })
    );
  }

  private async execute(text: string, values: unknown[]) {
    const result = await this.pool.query(postgresPlaceholders(text, values.length), values);
    return normalizeRows(result.rows);
  }

  async close() {
    this.onClose?.();
    await Promise.allSettled([...this.clients].map((client) => client.end()));
    await this.pool.end();
  }

  prepare(text: string) {
    return new PreparedStatement((text, values) => this.execute(text, values), text);
  }

  async transaction<T>(work: (sql: import("postgres").TransactionSql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query("BEGIN");
      const result = await work(transactionQueries(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      failed = true;
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release(failed);
    }
  }

  async batch(statements: PreparedStatement[]) {
    if (!statements.length) return [];
    return this.transaction(async (transaction) => {
      const results = [];
      for (const statement of statements) {
        const query = statement.toQuery();
        const rows = await transaction.unsafe(query.text, query.values as never[]);
        results.push({ success: true, results: normalizeRows(rows as Row[]) });
      }
      return results;
    });
  }
}

export type RuntimeEnv = {
  DB: PostgresDatabase;
};

const requestDatabase = new AsyncLocalStorage<PostgresDatabase>();
const poolCache = new Map<string, PostgresDatabase>();
let schemaReady: Promise<void> | undefined;
let schemaReadyKey = "";

function getOrCreatePool(connectionString: string): PostgresDatabase {
  const existing = poolCache.get(connectionString);
  if (existing) return existing;
  const created = new PostgresDatabase(connectionString, () => {
    poolCache.delete(connectionString);
  });
  poolCache.set(connectionString, created);
  return created;
}

export function getRuntimeEnv(): RuntimeEnv {
  const connectionString =
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL is not configured");
  const scoped = requestDatabase.getStore();
  return {
    DB: scoped || getOrCreatePool(connectionString),
  };
}

export async function ensureSchema(db: PostgresDatabase) {
  const key = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || "default";
  if (schemaReadyKey !== key) {
    schemaReady = undefined;
    schemaReadyKey = key;
  }
  schemaReady ??= initializeSchema(db).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

async function applyRlsHardening(db: PostgresDatabase, tables: string[]) {
  const listSql = tables.map((t) => `'${t}'`).join(",");
  await db
    .prepare(
      `DO $$ DECLARE t TEXT; r TEXT; BEGIN
        FOREACH t IN ARRAY ARRAY[${listSql}] LOOP
          IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
            FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
              IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = r) THEN
                EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
              END IF;
            END LOOP;
          END IF;
        END LOOP;
      END $$`,
    )
    .run()
    .catch((err) => {
      console.warn("RLS hardening step skipped", {
        tables,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

const authSchemaRevision = "2026-11-25-auth-v2";
export async function ensureAuthSchema(db: PostgresDatabase) {
  const current = await db
    .prepare("SELECT value FROM sync_state WHERE key='auth_schema_revision'")
    .first<{ value: string }>()
    .catch(() => null);
  if (current?.value === authSchemaRevision) return;

  await db.prepare("CREATE EXTENSION IF NOT EXISTS pgcrypto").run().catch(() => null);
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      encrypted_password TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      banned_until TIMESTAMPTZ DEFAULT NULL,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    .run();
  await db
    .prepare("ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ DEFAULT NULL")
    .run();
  await db
    .prepare("ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1")
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(LOWER(email))")
    .run();

  await db
    .prepare(`CREATE TABLE IF NOT EXISTS dashboard_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    .run();
  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user ON dashboard_sessions(user_id, revoked_at)")
    .run();

  await db
    .prepare(`CREATE TABLE IF NOT EXISTS auth_login_attempts (
      key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ
    )`)
    .run();

  await db
    .prepare(`CREATE TABLE IF NOT EXISTS api_rate_limits (
      key TEXT PRIMARY KEY,
      hits INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    .run();

  await applyRlsHardening(db, [
    "auth_users",
    "dashboard_sessions",
    "auth_login_attempts",
    "api_rate_limits",
  ]);
  await setSyncState(db, "auth_schema_revision", authSchemaRevision);
}

const coreSchemaRevision = "2026-11-25-rls-v2";
async function initializeSchema(db: PostgresDatabase) {
  const tables = await db
    .prepare(
      "SELECT to_regclass('public.sync_state') AS state, to_regclass('public.operations_schema_versions') AS versions"
    )
    .first<{ state: string | null; versions: string | null }>();
  if (tables?.state) {
    await ensureAuthSchema(db);
    const current = await db
      .prepare("SELECT value FROM sync_state WHERE key='core_schema_revision'")
      .first<{ value: string }>();
    if (current?.value === coreSchemaRevision) return;
    await applyRlsHardening(db, ["orders", "sync_state", "activity_logs"]);
    await ensureCoreSearchIndexes(db);
    await setSyncState(db, "core_schema_revision", coreSchemaRevision);
    return;
  }
  await createSchema(db);
  await ensureAuthSchema(db);
  await applyRlsHardening(db, ["orders", "sync_state", "activity_logs"]);
  await ensureCoreSearchIndexes(db);
  await setSyncState(db, "core_schema_revision", coreSchemaRevision);
}

async function ensureCoreSearchIndexes(db: PostgresDatabase) {
  await db.prepare("CREATE EXTENSION IF NOT EXISTS pg_trgm").run().catch(() => null);
  await db
    .prepare("CREATE INDEX IF NOT EXISTS idx_orders_created_at_desc ON orders (created_at DESC)")
    .run()
    .catch(() => null);
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_orders_search_trgm ON orders USING GIN ((channel_order_id || ' ' || awb || ' ' || customer_name || ' ' || customer_email || ' ' || customer_phone) gin_trgm_ops)",
    )
    .run()
    .catch(() => null);
}

async function createSchema(db: PostgresDatabase) {
  await db.batch([
    db.prepare(orderTagFunctionsSql),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT PRIMARY KEY, channel_order_id TEXT NOT NULL, channel_id INTEGER NOT NULL,
        channel_name TEXT NOT NULL, customer_name TEXT NOT NULL DEFAULT '',
        customer_email TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '',
        customer_city TEXT NOT NULL DEFAULT '', customer_state TEXT NOT NULL DEFAULT '',
        order_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '', delivered_at TEXT NOT NULL DEFAULT '',
        shipped_at TEXT NOT NULL DEFAULT '', out_for_delivery_at TEXT NOT NULL DEFAULT '',
        first_out_for_delivery_at TEXT NOT NULL DEFAULT '', ndr_reason TEXT NOT NULL DEFAULT '',
        ndr_attempts INTEGER NOT NULL DEFAULT 0, ndr_raised_at TEXT NOT NULL DEFAULT '',
        ndr_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT '', status_code INTEGER, payment_method TEXT NOT NULL DEFAULT '',
        payment_status TEXT NOT NULL DEFAULT '', total NUMERIC(14,2) NOT NULL DEFAULT 0,
        shipping_cost NUMERIC(14,2) NOT NULL DEFAULT 0, pickup_location TEXT NOT NULL DEFAULT '', awb TEXT NOT NULL DEFAULT '',
        courier TEXT NOT NULL DEFAULT '', shipment_id BIGINT,
        products_json TEXT NOT NULL DEFAULT '[]', raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL
      )
    `),
    db.prepare(`CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS activity_logs (id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, event_type TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL DEFAULT '', actor_role TEXT NOT NULL DEFAULT '')`),
    db.prepare("ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_id TEXT NOT NULL DEFAULT ''"),
    db.prepare("ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_name TEXT NOT NULL DEFAULT ''"),
    db.prepare("ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT ''"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_orders_channel_order_id ON orders (channel_order_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_orders_awb ON orders (awb)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs (created_at DESC)"),
  ]);
}

export type ActivityActor = {
  id?: string;
  name?: string;
  role?: string;
};

export async function logActivity(
  db: PostgresDatabase,
  source: string,
  eventType: string,
  message: string,
  details: Record<string, unknown> = {},
  level = "info",
  actor?: ActivityActor
) {
  const actorId =
    actor?.id ||
    (typeof details.actorId === "string"
      ? details.actorId
      : typeof details.actor_id === "string"
        ? details.actor_id
        : "system");
  const actorName =
    actor?.name ||
    (typeof details.actorName === "string"
      ? details.actorName
      : typeof details.actor_name === "string"
        ? details.actor_name
        : source || "System");
  const actorRole =
    actor?.role ||
    (typeof details.actorRole === "string"
      ? details.actorRole
      : typeof details.actor_role === "string"
        ? details.actor_role
        : "system");

  const mergedDetails = {
    ...details,
    ...(actorId ? { actorId } : {}),
    ...(actorName ? { actorName } : {}),
    ...(actorRole ? { actorRole } : {}),
  };

  try {
    await db
      .prepare(
        `INSERT INTO activity_logs (source, event_type, level, message, details_json, created_at, actor_id, actor_name, actor_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        source,
        eventType,
        level,
        message,
        JSON.stringify(mergedDetails),
        new Date().toISOString(),
        actorId,
        actorName,
        actorRole
      )
      .run();
  } catch {
    await db
      .prepare(
        `INSERT INTO activity_logs (source, event_type, level, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(source, eventType, level, message, JSON.stringify(mergedDetails), new Date().toISOString())
      .run();
  }
}

export async function setSyncState(db: PostgresDatabase, key: string, value: string) {
  await db
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

export async function withRequestDatabase<T>(work: () => Promise<T>, timeoutMs = 20000): Promise<T> {
  if (requestDatabase.getStore()) return work();
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return work();
  const db = getOrCreatePool(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await requestDatabase.run(db, () =>
      Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error("Data request timed out"), { code: "REQUEST_TIMEOUT" })),
            timeoutMs
          );
        }),
      ])
    );
  } finally {
    clearTimeout(timer);
  }
}
