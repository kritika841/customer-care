-- Additive migration 0025: Approval Mode Toggle, Associated Customer Phone & Review Decline Reason

ALTER TABLE support_ai_settings ADD COLUMN IF NOT EXISTS approval_mode_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS associated_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_approval_status TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ai_decline_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE support_ai_escalations ADD COLUMN IF NOT EXISTS decline_reason TEXT NOT NULL DEFAULT '';
