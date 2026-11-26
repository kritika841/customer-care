-- Additive migration 0026: Per-chat, per-request, and per-message AI token & spend tracking

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
