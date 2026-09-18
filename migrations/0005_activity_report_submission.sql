PRAGMA foreign_keys = ON;

CREATE TABLE report_activity_items (
  report_month TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  external_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','save_attempted','saved')),
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_month, application_id),
  UNIQUE (report_month, external_id)
);

CREATE INDEX idx_report_activity_items_state
  ON report_activity_items(report_month, state);
