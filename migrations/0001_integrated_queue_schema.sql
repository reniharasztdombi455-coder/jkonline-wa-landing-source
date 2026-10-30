-- WhatsApp visitor allocation schema.
-- Apply to a Cloudflare Preview D1 database first. Do not run against Production
-- until the Preview flow and migration have been verified.

CREATE TABLE IF NOT EXISTS landing_code_counters (
  slug TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS unique_customer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  event_type TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(slug, customer_code, event_type)
);

CREATE TABLE IF NOT EXISTS customer_code_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  session_token TEXT NOT NULL,
  customer_code TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'direct',
  agent TEXT NOT NULL DEFAULT 'unknown',
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  page_views INTEGER NOT NULL DEFAULT 0,
  whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, session_token)
);

CREATE TABLE IF NOT EXISTS wa_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  phone TEXT NOT NULL,
  max_per_cycle INTEGER NOT NULL DEFAULT 3,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS wa_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  customer_code TEXT NOT NULL UNIQUE,
  wa_number_id INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(slug, customer_code)
);

CREATE TABLE IF NOT EXISTS wa_route_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  cycle INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO wa_route_state(id, cycle) VALUES(1, 1);

CREATE TABLE IF NOT EXISTS wa_prefetch_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  wa_number_id INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  claimed_session_token TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  UNIQUE(slug, customer_code)
);

CREATE TABLE IF NOT EXISTS wa_queue_refill_locks (
  slug TEXT PRIMARY KEY,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_slug_token
  ON customer_code_sessions(slug, session_token);
CREATE INDEX IF NOT EXISTS idx_wa_assignments_number_cycle
  ON wa_assignments(wa_number_id, cycle);
CREATE INDEX IF NOT EXISTS idx_wa_queue_slug_status_id
  ON wa_prefetch_queue(slug, status, id);
