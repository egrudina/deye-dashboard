-- Dashboard v2 (docs/dashboard-v2-plan.md). All times are ms since epoch unless named otherwise.

-- Energy per clock hour (UTC hour start; Kyiv offsets are whole hours). Recomputed by the cron from `samples`.
CREATE TABLE hourly (
  hour_ts           INTEGER PRIMARY KEY,
  covered_s         REAL NOT NULL,     -- seconds of the hour covered by samples (gaps > 5 min are skipped)
  load_wh           REAL NOT NULL,
  load_a_wh         REAL NOT NULL,
  load_b_wh         REAL NOT NULL,
  load_c_wh         REAL NOT NULL,
  pv_wh             REAL NOT NULL,
  batt_charge_wh    REAL NOT NULL,
  batt_discharge_wh REAL NOT NULL,
  grid_import_wh    REAL NOT NULL,
  soc_min           INTEGER,
  soc_max           INTEGER,
  off_min           REAL NOT NULL,     -- minutes without grid (within covered time)
  updated_at        INTEGER NOT NULL
);

-- Latest Solcast forecast per 30-min period (kW, period_end = end of the period).
CREATE TABLE pv_forecast (
  period_end INTEGER PRIMARY KEY,
  p50        REAL NOT NULL,
  p10        REAL NOT NULL,
  p90        REAL NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- The first forecast seen for each period on its own Kyiv day (the "day-start" value), never overwritten.
CREATE TABLE pv_forecast_first (
  period_end INTEGER PRIMARY KEY,
  p50        REAL NOT NULL,
  p10        REAL NOT NULL,
  p90        REAL NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Yasno schedule per address role ('home', 'neighbour') and Kyiv date (YYYY-MM-DD).
CREATE TABLE outage_days (
  role       TEXT NOT NULL,
  date       TEXT NOT NULL,
  grp        TEXT NOT NULL,             -- e.g. '30.1'
  status     TEXT NOT NULL,             -- ScheduleApplies | WaitingForSchedule | EmergencyShutdowns | other
  slots      TEXT NOT NULL,             -- JSON [[startMin, endMin], ...] of Definite outages
  updated_on TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (role, date)
);

CREATE TABLE outage_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  role       TEXT NOT NULL,
  date       TEXT NOT NULL,
  before     TEXT,                      -- JSON {status, slots} or NULL (first time seen)
  after      TEXT NOT NULL
);
CREATE INDEX outage_changes_ts ON outage_changes (ts);

-- Shared settings and small state (addresses, groups, phase names, battery, Solcast counter...). value = JSON.
CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_settings (
  email      TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_success INTEGER,
  failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_email ON push_subscriptions (email);

CREATE TABLE notifications_sent (
  dedup_key TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX notifications_sent_ts ON notifications_sent (ts);
