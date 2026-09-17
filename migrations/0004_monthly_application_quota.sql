PRAGMA foreign_keys = ON;

CREATE TABLE monthly_application_slots (
  report_month TEXT NOT NULL,
  slot_no INTEGER NOT NULL CHECK (slot_no BETWEEN 1 AND 10),
  application_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'free'
    CHECK (state IN ('free','reserved','submitted','verified','uncertain')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_month, slot_no)
);

CREATE INDEX idx_monthly_application_slots_application
  ON monthly_application_slots(application_id);
