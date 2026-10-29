PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS landing_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
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
VALUES(1,'queue-test','Queue local test','15551234567','Hello, my code is TEST-AB/-1.','ci','test-agent','queue-ci','fixture',1);
