-- Add per-link WhatsApp contact behavior.
-- Run this once against the production D1 database bound to jkonline-wa-landing.
ALTER TABLE landing_links
ADD COLUMN contact_mode TEXT NOT NULL DEFAULT 'prefill'
CHECK (contact_mode IN ('prefill', 'code_only'));
