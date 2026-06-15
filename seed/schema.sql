-- SCADA Asset Control — D1 schema (archive edition)
-- Run (from this seed/ folder): wrangler d1 execute scada-store --remote --file=schema.sql
-- Then seed data: python3 seed/seed_d1.py   (run from the repo root)

-- ── Key-value store: config.json, zone_*_status.json, estimates.json ──────────
CREATE TABLE IF NOT EXISTS files (
  name       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── ON/OFF toggle records (was: records.csv) ──────────────────────────────────
-- "sn" comes from the CSV and is the natural primary key the front-end assigns.
-- INSERT OR IGNORE means re-sending the same row is always safe.
CREATE TABLE IF NOT EXISTS records (
  sn         TEXT PRIMARY KEY,
  personId   TEXT NOT NULL,
  personName TEXT NOT NULL,
  zone       TEXT NOT NULL,
  assetId    TEXT NOT NULL,
  assetName  TEXT NOT NULL,
  action     TEXT NOT NULL,             -- 'ON' | 'OFF'
  timestamp  TEXT NOT NULL,             -- ISO-8601, used for ordering + cooldown
  date       TEXT NOT NULL,             -- 'YYYY-MM-DD', used for month filtering
  time       TEXT NOT NULL,
  lat        REAL,
  lng        REAL,
  distance   REAL,
  gpsAcc     REAL,
  deviceId   TEXT NOT NULL
);

-- Index for the most common query: "give me this month's records"
CREATE INDEX IF NOT EXISTS idx_records_date ON records (date);
-- Index for the asset-status reconciliation query (latest record per asset)
CREATE INDEX IF NOT EXISTS idx_records_asset ON records (assetId, timestamp);

-- ── Leak/burst records (was: leakbursts.csv) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS leakbursts (
  sn         TEXT PRIMARY KEY,
  docket     TEXT,                      -- 'LB-YYYYMMDD-XXXX'
  personId   TEXT NOT NULL,
  personName TEXT NOT NULL,
  zone       TEXT NOT NULL,
  assetId    TEXT NOT NULL,
  assetName  TEXT NOT NULL,
  action     TEXT NOT NULL,             -- 'LEAK_BURST' | 'LEAK_BURST_CLEAR' | 'PIPE_ISSUE'
  issueType  TEXT,                      -- PIPE_ISSUE only: category (e.g. 'Low pressure')
  note       TEXT,                      -- PIPE_ISSUE only: free-text description
  timestamp  TEXT NOT NULL,
  date       TEXT NOT NULL,
  time       TEXT NOT NULL,
  lat        REAL,
  lng        REAL,
  distance   REAL,
  deviceId   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lb_asset ON leakbursts (assetId, timestamp);

-- ── Seed non-CSV files ────────────────────────────────────────────────────────
-- config.json, estimates.json, and zone status files go here.
-- Run seed_d1.py to populate them from your existing Gist exports.
INSERT OR IGNORE INTO files (name, content, updated_at) VALUES
  ('config.json',        '{}', datetime('now')),
  ('estimates.json',     '[]', datetime('now')),
  ('zone_a_status.json', '[]', datetime('now')),
  ('zone_b_status.json', '[]', datetime('now')),
  ('zone_c_status.json', '[]', datetime('now'));
