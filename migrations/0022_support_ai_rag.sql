-- Additive migration 0022: Autonomous AI Support Agent, Hybrid Store RAG, 10k-Token Compaction & Safety Gates
-- Zero existing rows are deleted or destructively modified.

-- 1. Expand support_messages.delivery_status check constraint to allow 'ai_draft'
-- so AI drafts are never picked up by flushOutbox() or flushMetaOutbox().
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

-- 2. Add AI state and 10,000-token rolling conversation compaction columns to support_tickets
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(4,3);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_summary_up_to_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_summary_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_pinned_facts JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_last_processed_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_turn_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_support_tickets_ai_status ON support_tickets (ai_status, updated_at DESC);

-- 3. AI Settings & Safety Configuration (defaults strictly to 'draft_only' and live_outbound_enabled = FALSE)
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

-- 4. Store Knowledge Documents & Chunks for Hybrid RAG (Vector + Lexical Full-Text Search)
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

-- 5. AI Escalations & Admin Clarifications Table
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

-- 6. Row Level Security on new tables
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
