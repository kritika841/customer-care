-- Additive migration 0024: Security, AI Concurrency/Backoff, RAG Embedding Provenance & Search Performance

-- 1. Ticket Reply-To, inbound auth provenance, CSAT expiry, and AI per-ticket lease/backoff
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reply_to_email TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS inbound_auth_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_expires_at TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_lock_until TIMESTAMPTZ;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_next_retry_at TIMESTAMPTZ;

-- 2. Partial Meta outbound delivery tracking
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS meta_delivery_state JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_latest
  ON support_messages (ticket_id, created_at DESC, id DESC)
  WHERE delivery_status <> 'ai_draft';

-- 3. RAG embedding provenance & document governance
ALTER TABLE support_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT '';
ALTER TABLE support_knowledge_documents ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE support_knowledge_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- 4. RLS on core & auth tables
DO $$ DECLARE t TEXT; r TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders','sync_state','activity_logs','auth_users',
    'dashboard_sessions','auth_login_attempts','api_rate_limits'
  ] LOOP
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
