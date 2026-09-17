PRAGMA foreign_keys = ON;

CREATE TABLE integration_probes (
  id TEXT PRIMARY KEY,
  automation_run_id TEXT NOT NULL REFERENCES automation_runs(id),
  integration TEXT NOT NULL CHECK (integration IN ('arbetsformedlingen_activity_report')),
  status TEXT NOT NULL CHECK (status IN ('captured','failed')),
  page_url TEXT,
  object_key TEXT,
  summary_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_integration_probes_run
  ON integration_probes(automation_run_id, created_at DESC);
