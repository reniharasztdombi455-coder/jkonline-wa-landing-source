-- WhatsApp group routing. Apply only after preview validation and explicit production approval.
ALTER TABLE landing_links ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'phone'
  CHECK(routing_mode IN ('phone','group'));

CREATE TABLE IF NOT EXISTS wa_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  invite_url TEXT NOT NULL,
  max_members INTEGER NOT NULL DEFAULT 100,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS wa_group_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(slug, customer_code),
  FOREIGN KEY(group_id) REFERENCES wa_groups(id)
);
CREATE INDEX IF NOT EXISTS idx_wa_group_assignments_group ON wa_group_assignments(group_id);
CREATE INDEX IF NOT EXISTS idx_wa_group_assignments_slug ON wa_group_assignments(slug);
