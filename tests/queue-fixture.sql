PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS landing_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  contact_mode TEXT NOT NULL DEFAULT 'prefill',
  source TEXT DEFAULT 'test',
  agent TEXT DEFAULT 'test-agent',
  campaign TEXT,
  ad TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT,
  agent TEXT,
  campaign TEXT,
  ad TEXT,
  button_type TEXT,
  page_path TEXT,
  referrer_host TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR REPLACE INTO landing_links(id,slug,name,phone,message,source,agent,campaign,ad,enabled)
VALUES
 (1,'queue-test','Queue local test','15551234567','Hello, my code is TEST-AB/-1.','ci','test-agent','queue-ci','fixture',1),
 (2,'queue-test-2','Queue local test 2','15551234567','Hello, my code is TEST-AB/-1.','ci','test-agent','queue-ci','fixture-2',1);

-- Queue tables are provisioned ahead of requests in production. The isolated
-- CI database must create the same schema before exercising the hot path.
CREATE TABLE IF NOT EXISTS landing_code_counters (
  slug TEXT PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, session_token TEXT NOT NULL,
  customer_code TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'direct',
  agent TEXT NOT NULL DEFAULT 'unknown',
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  page_views INTEGER NOT NULL DEFAULT 0, whatsapp_clicks INTEGER NOT NULL DEFAULT 0,
  UNIQUE(slug, session_token)
);
CREATE TABLE IF NOT EXISTS wa_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, phone TEXT NOT NULL,
  max_per_cycle INTEGER NOT NULL DEFAULT 3, sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS wa_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, customer_code TEXT NOT NULL,
  wa_number_id INTEGER NOT NULL, cycle INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(slug, customer_code)
);
CREATE TABLE IF NOT EXISTS wa_route_state (
  id INTEGER PRIMARY KEY CHECK(id=1), cycle INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO wa_route_state(id,cycle) VALUES(1,1);
CREATE TABLE IF NOT EXISTS wa_prefetch_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, customer_code TEXT NOT NULL UNIQUE,
  wa_number_id INTEGER NOT NULL, cycle INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
  claimed_session_token TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT, UNIQUE(slug, customer_code)
);
CREATE TABLE IF NOT EXISTS wa_queue_refill_locks (
  slug TEXT PRIMARY KEY, locked_until INTEGER NOT NULL DEFAULT 0
);
