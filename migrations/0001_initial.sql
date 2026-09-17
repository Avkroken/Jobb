PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  employer TEXT,
  location TEXT,
  country_code TEXT,
  is_international INTEGER NOT NULL DEFAULT 0 CHECK (is_international IN (0, 1)),
  source_url TEXT NOT NULL,
  raw_json TEXT,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, external_id)
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL CHECK (status IN ('queued','applying','submitted','verified','failed','needs_user_action')),
  applied_at TEXT,
  verified_at TEXT,
  report_month TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id)
);

CREATE TABLE application_attempts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','submitted','verified','failed','unknown')),
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(application_id, attempt_no)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  report_month TEXT NOT NULL UNIQUE,
  target_count INTEGER NOT NULL DEFAULT 10 CHECK (target_count > 0),
  status TEXT NOT NULL CHECK (status IN ('collecting','ready','needs_user_auth','submitting','submitted','failed')),
  submitted_at TEXT,
  external_reference TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_applications_report_month_status ON applications(report_month, status);
CREATE INDEX idx_attempts_application ON application_attempts(application_id, attempt_no);
