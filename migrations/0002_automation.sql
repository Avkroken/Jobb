PRAGMA foreign_keys = ON;

ALTER TABLE applications ADD COLUMN automation_run_id TEXT;

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('manual','scheduled')),
  application_month TEXT NOT NULL,
  report_month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','needs_user_auth','completed','failed')),
  target_count INTEGER NOT NULL DEFAULT 10 CHECK (target_count > 0),
  verified_count INTEGER NOT NULL DEFAULT 0 CHECK (verified_count >= 0),
  workflow_instance_id TEXT,
  auth_session_id TEXT,
  auth_live_view_url TEXT,
  auth_expires_at TEXT,
  last_notified_at TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_automation_runs_month_mode
  ON automation_runs(application_month, mode, started_at DESC);
CREATE INDEX idx_automation_runs_status
  ON automation_runs(status, updated_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  automation_run_id TEXT NOT NULL REFERENCES automation_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('bankid_required','run_failed','run_completed')),
  channel TEXT NOT NULL CHECK (channel IN ('email','webhook')),
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_run
  ON notifications(automation_run_id, created_at DESC);
