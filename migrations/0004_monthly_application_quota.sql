PRAGMA foreign_keys = ON;

CREATE TABLE monthly_application_slots (
  report_month TEXT NOT NULL,
  slot_no INTEGER NOT NULL CHECK (slot_no BETWEEN 1 AND 10),
  application_id TEXT UNIQUE,
  reservation_owner TEXT,
  state TEXT NOT NULL DEFAULT 'free'
    CHECK (state IN ('free','reserved','submitted','verified','uncertain')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_month, slot_no)
);

CREATE INDEX idx_monthly_application_slots_application
  ON monthly_application_slots(application_id);

CREATE INDEX idx_monthly_application_slots_owner
  ON monthly_application_slots(report_month, reservation_owner);

-- Seed ten slots for every month that already has non-failed application activity.
WITH RECURSIVE slot_numbers(slot_no) AS (
  SELECT 1
  UNION ALL
  SELECT slot_no + 1 FROM slot_numbers WHERE slot_no < 10
),
months AS (
  SELECT DISTINCT report_month
  FROM applications
  WHERE status IN ('applying','submitted','verified','needs_user_action')
)
INSERT OR IGNORE INTO monthly_application_slots (report_month, slot_no, state)
SELECT months.report_month, slot_numbers.slot_no, 'free'
FROM months CROSS JOIN slot_numbers;

-- Backfill existing potentially-submitted applications so rollout cannot create
-- an 11th submission before the new quota table has observed historical state.
WITH ranked AS (
  SELECT
    id,
    report_month,
    status,
    ROW_NUMBER() OVER (
      PARTITION BY report_month
      ORDER BY COALESCE(verified_at, applied_at, created_at), id
    ) AS slot_no
  FROM applications
  WHERE status IN ('applying','submitted','verified','needs_user_action')
)
UPDATE monthly_application_slots
SET
  application_id = (
    SELECT ranked.id
    FROM ranked
    WHERE ranked.report_month = monthly_application_slots.report_month
      AND ranked.slot_no = monthly_application_slots.slot_no
  ),
  reservation_owner = 'migration',
  state = COALESCE((
    SELECT CASE ranked.status
      WHEN 'verified' THEN 'verified'
      WHEN 'submitted' THEN 'submitted'
      ELSE 'uncertain'
    END
    FROM ranked
    WHERE ranked.report_month = monthly_application_slots.report_month
      AND ranked.slot_no = monthly_application_slots.slot_no
  ), state),
  updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM ranked
  WHERE ranked.report_month = monthly_application_slots.report_month
    AND ranked.slot_no = monthly_application_slots.slot_no
    AND ranked.slot_no <= 10
);
