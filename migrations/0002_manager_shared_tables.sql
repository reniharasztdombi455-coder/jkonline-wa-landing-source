-- Additive shared manager tables. No existing production tables are altered.
CREATE TABLE IF NOT EXISTS customer_followups (
  customer_code TEXT PRIMARY KEY,
  followup_status TEXT NOT NULL DEFAULT '待联系',
  followup_notes TEXT NOT NULL DEFAULT '',
  followup_owner TEXT NOT NULL DEFAULT '',
  next_followup_at TEXT NOT NULL DEFAULT '',
  contacted_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS campaign_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spend_date TEXT NOT NULL,
  campaign TEXT NOT NULL,
  ad TEXT NOT NULL DEFAULT 'unspecified',
  amount REAL NOT NULL CHECK(amount >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(spend_date, campaign, ad)
);
