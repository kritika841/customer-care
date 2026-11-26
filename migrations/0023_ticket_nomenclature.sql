-- Additive migration 0023: Configurable Ticket Nomenclature (Admin)
ALTER TABLE support_ai_settings ADD COLUMN IF NOT EXISTS ticket_label_singular TEXT NOT NULL DEFAULT 'Ticket';
ALTER TABLE support_ai_settings ADD COLUMN IF NOT EXISTS ticket_label_plural TEXT NOT NULL DEFAULT 'Tickets';
