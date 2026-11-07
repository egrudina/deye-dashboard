-- Decoded samples, kept forever. ts = ms since epoch (Worker receive time - age_ms).
CREATE TABLE samples (
  ts            INTEGER PRIMARY KEY,
  grid_on       INTEGER NOT NULL,  -- reg 607 (uint16) > 0, same rule as the bot
  soc           INTEGER,           -- 588, %
  batt_w        INTEGER,           -- 590, signed; Deye: + discharge, - charge
  grid_w        INTEGER,           -- 607, signed
  ext_ct_w      INTEGER,           -- 619, signed ("input power" in the bot)
  grid_total_w  INTEGER,           -- 625, signed (unverified)
  grid_v_a      REAL, grid_v_b REAL, grid_v_c REAL,  -- 598-600 /10 (unverified)
  grid_hz       REAL,              -- 609 /100 (unverified)
  load_a        INTEGER, load_b INTEGER, load_c INTEGER,  -- 650-652
  load_total    INTEGER,           -- 653
  pv1_w         INTEGER, pv2_w INTEGER,  -- 672-673 (unverified)
  pv_w          INTEGER            -- 672+673+674+675
);

-- Raw registers for re-decoding after mapping fixes. 7 days only.
CREATE TABLE raw_samples (
  ts    INTEGER PRIMARY KEY,
  start INTEGER NOT NULL,
  regs  TEXT NOT NULL              -- JSON array of uint16
);

-- Grid state transitions, written at ingest. prev_ts = last sample with the opposite state,
-- so the real transition happened somewhere in (prev_ts, ts].
CREATE TABLE grid_events (
  ts      INTEGER PRIMARY KEY,
  grid_on INTEGER NOT NULL,
  prev_ts INTEGER
);

CREATE TABLE heartbeats (
  received_at INTEGER PRIMARY KEY,
  pi_wall_ms  INTEGER,
  json        TEXT NOT NULL
);
