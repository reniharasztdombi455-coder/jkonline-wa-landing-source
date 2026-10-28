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
DELETE FROM wa_numbers;
INSERT INTO wa_numbers(id,label,phone,max_per_cycle,sort_order,enabled) VALUES
 (1,'Test number 1','15551230001',1,1,1),
 (2,'Test number 2','15551230002',1,2,1),
 (3,'Test number 3','15551230003',1,3,1),
 (4,'Test number 4','15551230004',1,4,1),
 (5,'Test number 5','15551230005',1,5,1);
