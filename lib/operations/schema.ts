import { ensureSchema, getRuntimeEnv } from "../database";

const statements: string[] = [
  "CREATE TABLE IF NOT EXISTS support_mailboxes (email TEXT PRIMARY KEY, encrypted_refresh_token TEXT NOT NULL DEFAULT '', history_id TEXT NOT NULL DEFAULT '', import_cursor TEXT NOT NULL DEFAULT '', import_since TEXT NOT NULL DEFAULT '', import_complete BOOLEAN NOT NULL DEFAULT FALSE, watch_expiration BIGINT NOT NULL DEFAULT 0, last_sync_at TIMESTAMPTZ, last_error TEXT NOT NULL DEFAULT '', connected_by TEXT NOT NULL, sync_lease_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());\n",
  "CREATE TABLE IF NOT EXISTS support_agents (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('support_agent','support_manager','admin')), available BOOLEAN NOT NULL DEFAULT TRUE);\n",
  "CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, ticket_number BIGSERIAL UNIQUE, mailbox TEXT NOT NULL REFERENCES support_mailboxes(email), gmail_thread_id TEXT NOT NULL, subject TEXT NOT NULL, customer_email TEXT NOT NULL, customer_name TEXT NOT NULL DEFAULT '', assignee_id TEXT REFERENCES support_agents(user_id), status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','escalated','resolved')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')), order_id BIGINT REFERENCES orders(id), version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(mailbox,gmail_thread_id));\n",
  "CREATE TABLE IF NOT EXISTS support_messages (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id), gmail_message_id TEXT UNIQUE, message_id TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','note')), sender TEXT NOT NULL, recipients TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, attachments JSONB NOT NULL DEFAULT '[]', delivery_status TEXT NOT NULL DEFAULT 'received' CHECK(delivery_status IN ('received','queued','sending','sent','failed','uncertain','note','ai_draft')), request_key TEXT UNIQUE, resolve_after_send BOOLEAN NOT NULL DEFAULT FALSE, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());\n",
  "CREATE TABLE IF NOT EXISTS support_events (id BIGSERIAL PRIMARY KEY, ticket_id TEXT REFERENCES support_tickets(id), actor_id TEXT NOT NULL, action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());\n",
  "CREATE INDEX IF NOT EXISTS idx_support_queue ON support_tickets(assignee_id,status,updated_at DESC);\n",
  "CREATE INDEX IF NOT EXISTS idx_support_messages ON support_messages(ticket_id,created_at);\n",
  "CREATE INDEX IF NOT EXISTS idx_support_outbox ON support_messages(delivery_status,created_at) WHERE direction='outbound';\n",
  "DO $$ DECLARE t TEXT; r TEXT; BEGIN\n FOREACH t IN ARRAY ARRAY['support_mailboxes','support_agents','support_tickets','support_messages','support_events'] LOOP\n  IF to_regclass('public.' || t) IS NOT NULL THEN\n   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);\n   FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP\n    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',t,r); END IF;\n   END LOOP;\n  END IF;\n END LOOP;\nEND $$;\n",
];

let ready: Promise<void> | undefined;

export async function operationsDb() {
  const db = getRuntimeEnv().DB;
  await ensureSchema(db);
  ready ??= (async () => {
    const exists = await db
      .prepare("SELECT to_regclass('public.operations_schema_versions') name")
      .first<{ name: string }>();
    if (
      exists?.name &&
      (await db
        .prepare("SELECT version FROM operations_schema_versions WHERE version='0026_token_usage_and_sorting'")
        .first())
    )
      return;
    await db.transaction(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(421995)`;
      await sql`CREATE TABLE IF NOT EXISTS operations_schema_versions (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await sql`ALTER TABLE operations_schema_versions ENABLE ROW LEVEL SECURITY`;
      const [version] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0012_operations'`;
      if (!version) {
        for (const statement of statements) await sql.unsafe(statement);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0012_operations')`;
      } else {
        // Ensure support tables exist even if 0012 was marked on an inventory-only db
        for (const statement of statements) await sql.unsafe(statement);
      }
      const [outboxVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0013_support_outbox'`;
      if (!outboxVersion) {
        await sql`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ`;
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0013_support_outbox')`;
      }
      const [supportReadVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0018_support_read_performance'`;
      if (!supportReadVersion) {
        await sql.unsafe(SUPPORT_READ_PERFORMANCE_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0018_support_read_performance')`;
      }
      const [templatesVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0019_support_templates'`;
      if (!templatesVersion) {
        await sql.unsafe(SUPPORT_TEMPLATES_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0019_support_templates')`;
      }
      const [omnichannelVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0020_support_omnichannel'`;
      if (!omnichannelVersion) {
        await sql.unsafe(SUPPORT_OMNICHANNEL_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0020_support_omnichannel')`;
      }
      const [stage2Version] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0021_support_stage2'`;
      if (!stage2Version) {
        await sql.unsafe(SUPPORT_STAGE2_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0021_support_stage2')`;
      }
      const [aiRagVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0022_support_ai_rag'`;
      if (!aiRagVersion) {
        await sql.unsafe(SUPPORT_AI_RAG_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0022_support_ai_rag')`;
      }
      const [nomenclatureVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0023_ticket_nomenclature'`;
      if (!nomenclatureVersion) {
        await sql.unsafe(SUPPORT_NOMENCLATURE_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0023_ticket_nomenclature')`;
      }
      const [hardeningVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0024_security_ai_hardening'`;
      if (!hardeningVersion) {
        await sql.unsafe(SUPPORT_HARDENING_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0024_security_ai_hardening')`;
      }
      const [approvalQueueVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0025_approval_queue_phone_tracking'`;
      if (!approvalQueueVersion) {
        await sql.unsafe(SUPPORT_APPROVAL_QUEUE_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0025_approval_queue_phone_tracking')`;
      }
      const [tokenUsageVersion] =
        await sql`SELECT version FROM operations_schema_versions WHERE version='0026_token_usage_and_sorting'`;
      if (!tokenUsageVersion) {
        await sql.unsafe(SUPPORT_TOKEN_USAGE_MIGRATION);
        await sql`INSERT INTO operations_schema_versions(version) VALUES('0026_token_usage_and_sorting')`;
      }
    });
    await ensureOptionalExtensionsAndIndexes(db);
  })().catch((e) => {
    ready = undefined;
    throw e;
  });
  await ready;
  return db;
}

const SUPPORT_READ_PERFORMANCE_MIGRATION = `
CREATE INDEX IF NOT EXISTS idx_support_tickets_updated ON support_tickets (updated_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee_status ON support_tickets (assignee_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer_email ON support_tickets (LOWER(customer_email));
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders (LOWER(customer_email),created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_events_ticket_created ON support_events (ticket_id,created_at);
`;

const SUPPORT_TEMPLATES_MIGRATION = `
CREATE TABLE IF NOT EXISTS support_reply_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name)
);
CREATE INDEX IF NOT EXISTS idx_support_reply_templates_updated ON support_reply_templates(updated_at DESC);
INSERT INTO support_reply_templates(id,name,body,created_by,updated_by) VALUES
  ('support-template-acknowledgement','Acknowledgement','Hi {{customer_name}},\n\nThanks for getting in touch. We have received your request and are looking into it. We will update you shortly.\n\nRegards,\nSatmi Support','system','system'),
  ('support-template-order-update','Order status update','Hi {{customer_name}},\n\nThanks for your patience. We are checking the latest update for your order and will share the details as soon as possible.\n\nRegards,\nSatmi Support','system','system'),
  ('support-template-resolution','Resolution confirmation','Hi {{customer_name}},\n\nYour request has been resolved. Please reply to this email if you need any further help.\n\nRegards,\nSatmi Support','system','system')
ON CONFLICT(name) DO NOTHING;
ALTER TABLE support_reply_templates ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE public.support_reply_templates FROM %I',r); END IF;
  END LOOP;
END $$;
`;

const SUPPORT_OMNICHANNEL_MIGRATION = `
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS external_user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS external_username TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_support_tickets_channel ON support_tickets (channel, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_social_accounts (
  channel TEXT PRIMARY KEY CHECK(channel IN ('facebook','instagram')),
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  page_id TEXT NOT NULL DEFAULT '',
  encrypted_access_token TEXT NOT NULL DEFAULT '',
  last_sync_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  connected_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE support_social_accounts ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE public.support_social_accounts FROM %I',r); END IF;
  END LOOP;
END $$;
`;

const SUPPORT_STAGE2_MIGRATION = `
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_token TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_score SMALLINT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_comment TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_submitted_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS viewing_by JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_csat_token
  ON support_tickets (csat_token) WHERE csat_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_sla_due
  ON support_tickets (sla_due_at ASC) WHERE status <> 'resolved';

ALTER TABLE support_agents ADD COLUMN IF NOT EXISTS max_open_tickets INTEGER NOT NULL DEFAULT 25;
ALTER TABLE support_agents ADD COLUMN IF NOT EXISTS preferred_channels JSONB NOT NULL DEFAULT '["email","instagram","facebook"]'::jsonb;

ALTER TABLE support_reply_templates ADD COLUMN IF NOT EXISTS macro_status TEXT NOT NULL DEFAULT '';
ALTER TABLE support_reply_templates ADD COLUMN IF NOT EXISTS macro_priority TEXT NOT NULL DEFAULT '';
ALTER TABLE support_reply_templates ADD COLUMN IF NOT EXISTS macro_tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE support_reply_templates ADD COLUMN IF NOT EXISTS shortcut TEXT NOT NULL DEFAULT '';

INSERT INTO support_reply_templates(id,name,body,macro_status,macro_priority,macro_tags,shortcut,created_by,updated_by)
VALUES (
  'support-template-ndr',
  'NDR Update',
  'Hi {{customer_name}},\n\nWe noticed a delivery re-attempt is needed for your order {{order_id}}. Our logistics team has prioritized your shipment with the courier for delivery on the next working attempt. Please share an alternate phone number or landmark if needed.\n\nRegards,\nSatmi Support',
  'waiting',
  'high',
  '["NDR"]'::jsonb,
  'ndr',
  'system',
  'system'
)
ON CONFLICT(name) DO NOTHING;

CREATE TABLE IF NOT EXISTS support_customer_links (
  channel TEXT NOT NULL CHECK(channel IN ('email','facebook','instagram')),
  external_user_id TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  linked_order_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_user_id)
);
ALTER TABLE support_customer_links ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE public.support_customer_links FROM %I',r); END IF;
  END LOOP;
END $$;

UPDATE support_tickets t
SET first_response_at = COALESCE(
      t.first_response_at,
      (SELECT MIN(sm.created_at) FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.direction = 'outbound')
    ),
    last_inbound_at = COALESCE(
      t.last_inbound_at,
      (SELECT MAX(sm.created_at) FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.direction = 'inbound'),
      t.created_at
    ),
    resolved_at = COALESCE(
      t.resolved_at,
      CASE WHEN t.status = 'resolved' THEN t.updated_at ELSE NULL END
    ),
    sla_due_at = COALESCE(
      t.sla_due_at,
      t.created_at + (
        CASE t.priority
          WHEN 'urgent' THEN interval '1 hour'
          WHEN 'high' THEN interval '4 hours'
          WHEN 'low' THEN interval '24 hours'
          ELSE interval '12 hours'
        END
      )
    );
`;

const SUPPORT_AI_RAG_MIGRATION = `
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'support_messages_delivery_status_check'
      AND conrelid = 'public.support_messages'::regclass
  ) THEN
    ALTER TABLE public.support_messages DROP CONSTRAINT support_messages_delivery_status_check;
  END IF;
  ALTER TABLE public.support_messages
    ADD CONSTRAINT support_messages_delivery_status_check
    CHECK (delivery_status IN ('received','queued','sending','sent','failed','uncertain','note','ai_draft'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(4,3);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_summary_up_to_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_summary_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_pinned_facts JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_last_processed_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_turn_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_support_tickets_ai_status ON support_tickets (ai_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_ai_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  operating_mode TEXT NOT NULL DEFAULT 'draft_only'
    CHECK (operating_mode IN ('off', 'draft_only', 'allowlist_only', 'live_auto')),
  live_outbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  test_recipient_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  compaction_token_threshold INTEGER NOT NULL DEFAULT 10000,
  auto_reply_confidence_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.820,
  vip_order_value_threshold NUMERIC(14,2) NOT NULL DEFAULT 3000.00,
  debounce_seconds INTEGER NOT NULL DEFAULT 30,
  human_action_policies JSONB NOT NULL DEFAULT '["arrange_callback","damaged_or_wrong_item","manual_refund_or_bank_transfer","vip_high_value_order","angry_or_abusive_sentiment"]'::jsonb,
  brand_persona_prompt TEXT NOT NULL DEFAULT 'You are Satmi Support AI, the official customer support specialist for Satmi. Be warm, concise, empathetic, and strictly grounded in verified store policies, product catalog data, and the customer''s live order context. Never invent order numbers, AWB tracking codes, discounts, or policies.',
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO support_ai_settings (id, operating_mode, live_outbound_enabled)
VALUES ('default', 'draft_only', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS support_knowledge_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('policy', 'product', 'faq', 'admin_memory', 'template')),
  source_ref TEXT NOT NULL DEFAULT '',
  source_ticket_id TEXT REFERENCES support_tickets(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_category ON support_knowledge_documents (category, is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_source_ref ON support_knowledge_documents (source_ref) WHERE source_ref <> '';

CREATE TABLE IF NOT EXISTS support_knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES support_knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(heading, '') || ' ' || coalesce(content, ''))
  ) STORED,
  embedding_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON support_knowledge_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tsv ON support_knowledge_chunks USING GIN (search_tsv);

CREATE TABLE IF NOT EXISTS support_ai_escalations (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  trigger_message_id TEXT,
  escalation_type TEXT NOT NULL CHECK (escalation_type IN ('missing_context', 'human_action_required')),
  action_category TEXT NOT NULL DEFAULT '',
  ai_question_for_admin TEXT NOT NULL,
  customer_query_excerpt TEXT NOT NULL DEFAULT '',
  retrieved_context_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'dismissed')),
  admin_raw_answer TEXT NOT NULL DEFAULT '',
  ai_rephrased_reply TEXT NOT NULL DEFAULT '',
  saved_to_memory BOOLEAN NOT NULL DEFAULT FALSE,
  memory_document_id TEXT REFERENCES support_knowledge_documents(id) ON DELETE SET NULL,
  answered_by TEXT,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_escalations_ticket ON support_ai_escalations (ticket_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_escalations_pending ON support_ai_escalations (status, created_at DESC) WHERE status = 'pending';

DO $$ DECLARE t TEXT; r TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['support_ai_settings','support_knowledge_documents','support_knowledge_chunks','support_ai_escalations'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;
`;

const SUPPORT_NOMENCLATURE_MIGRATION = `
ALTER TABLE support_ai_settings ADD COLUMN IF NOT EXISTS ticket_label_singular TEXT NOT NULL DEFAULT 'Ticket';
ALTER TABLE support_ai_settings ADD COLUMN IF NOT EXISTS ticket_label_plural TEXT NOT NULL DEFAULT 'Tickets';
`;

const SUPPORT_HARDENING_MIGRATION = `
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reply_to_email TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS inbound_auth_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_expires_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_lock_until TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_next_retry_at TIMESTAMPTZ;

ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS meta_delivery_state JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_latest
  ON support_messages (ticket_id, created_at DESC, id DESC)
  WHERE delivery_status <> 'ai_draft';

ALTER TABLE support_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT '';
ALTER TABLE support_knowledge_documents ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE support_knowledge_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
`;

const SUPPORT_APPROVAL_QUEUE_MIGRATION = `
ALTER TABLE support_ai_settings ADD COLUMN IF NOT EXISTS approval_mode_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS associated_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_approval_status TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_decline_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE support_ai_escalations ADD COLUMN IF NOT EXISTS decline_reason TEXT NOT NULL DEFAULT '';
`;

const SUPPORT_TOKEN_USAGE_MIGRATION = `
CREATE TABLE IF NOT EXISTS support_ai_token_usage (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES support_tickets(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL DEFAULT '',
  operation_type TEXT NOT NULL DEFAULT 'triage',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0,
  actor_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_token_usage_ticket ON support_ai_token_usage (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_message ON support_ai_token_usage (message_id) WHERE message_id <> '';
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_created ON support_ai_token_usage (created_at DESC);

ALTER TABLE support_ai_token_usage ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.support_ai_token_usage FROM %I', r);
    END IF;
  END LOOP;
END $$;
`;

let pgVectorAvailableCache: boolean | null = null;

export async function isPgVectorAvailable(): Promise<boolean> {
  if (pgVectorAvailableCache !== null) return pgVectorAvailableCache;
  try {
    const db = getRuntimeEnv().DB;
    const row = await db
      .prepare("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vec")
      .first<{ has_vec: boolean }>();
    pgVectorAvailableCache = Boolean(row?.has_vec);
  } catch {
    pgVectorAvailableCache = false;
  }
  return pgVectorAvailableCache;
}

async function ensureOptionalExtensionsAndIndexes(db: ReturnType<typeof getRuntimeEnv>["DB"]) {
  // Optional pg_trgm indexes for fast ILIKE ticket search
  await db.prepare("CREATE EXTENSION IF NOT EXISTS pg_trgm").run().catch(() => null);
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_support_tickets_search_trgm ON support_tickets USING GIN ((subject || ' ' || customer_email || ' ' || customer_name || ' ' || external_username) gin_trgm_ops)",
    )
    .run()
    .catch(() => null);

  // Optional pgvector HNSW index when running on PostgreSQL/Supabase with vector extension
  await db.prepare("CREATE EXTENSION IF NOT EXISTS vector").run().catch(() => null);
  const hasVec = await db
    .prepare("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vec")
    .first<{ has_vec: boolean }>()
    .catch(() => ({ has_vec: false }));
  pgVectorAvailableCache = Boolean(hasVec?.has_vec);
  if (pgVectorAvailableCache) {
    await db
      .prepare("ALTER TABLE support_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(768)")
      .run()
      .catch(() => null);
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw ON support_knowledge_chunks USING hnsw (embedding vector_cosine_ops)",
      )
      .run()
      .catch(() => null);
  }
}
