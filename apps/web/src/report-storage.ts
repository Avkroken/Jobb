import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";

export interface ReportApplicationRow {
  applicationId: string;
  externalId: string;
  title: string;
  employer: string | null;
  location: string | null;
  countryCode: string | null;
  isInternational: boolean;
  appliedAt: string;
  rawJson: string | null;
}

export interface ReportActivityItemRow {
  report_month: string;
  application_id: string;
  external_id: string;
  state: "pending" | "save_attempted" | "saved";
  last_error: string | null;
  updated_at: string;
}

export async function loadVerifiedReportApplications(
  db: D1Database,
  reportMonth: string,
): Promise<ReportApplicationRow[]> {
  const rows = await db
    .prepare(
      `SELECT a.id AS application_id, a.applied_at,
              j.external_id, j.title, j.employer, j.location, j.country_code,
              j.is_international, j.raw_json
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.report_month = ?
         AND a.status = 'verified'
         AND a.applied_at IS NOT NULL
       ORDER BY a.applied_at, a.id`,
    )
    .bind(reportMonth)
    .all<{
      application_id: string;
      applied_at: string;
      external_id: string;
      title: string;
      employer: string | null;
      location: string | null;
      country_code: string | null;
      is_international: number;
      raw_json: string | null;
    }>();

  if (rows.results.length !== MONTHLY_APPLICATION_TARGET) {
    throw new Error(
      `REPORT_APPLICATION_COUNT_MISMATCH: expected exactly ${MONTHLY_APPLICATION_TARGET} verified applications for ${reportMonth}, found ${rows.results.length}.`,
    );
  }

  return rows.results.map((row) => ({
    applicationId: row.application_id,
    externalId: row.external_id,
    title: row.title,
    employer: row.employer,
    location: row.location,
    countryCode: row.country_code,
    isInternational: Boolean(row.is_international),
    appliedAt: row.applied_at,
    rawJson: row.raw_json,
  }));
}

export async function ensureReportActivityItems(
  db: D1Database,
  reportMonth: string,
  applications: ReportApplicationRow[],
): Promise<void> {
  await db.batch(
    applications.map((application) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO report_activity_items
           (report_month, application_id, external_id, state)
           VALUES (?, ?, ?, 'pending')`,
        )
        .bind(reportMonth, application.applicationId, application.externalId),
    ),
  );
}

export async function getReportActivityItem(
  db: D1Database,
  reportMonth: string,
  applicationId: string,
): Promise<ReportActivityItemRow | null> {
  return db
    .prepare(
      `SELECT * FROM report_activity_items
       WHERE report_month = ? AND application_id = ?`,
    )
    .bind(reportMonth, applicationId)
    .first<ReportActivityItemRow>();
}

export async function setReportActivityItemState(
  db: D1Database,
  reportMonth: string,
  applicationId: string,
  state: ReportActivityItemRow["state"],
  error: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE report_activity_items
       SET state = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE report_month = ? AND application_id = ?`,
    )
    .bind(state, error, reportMonth, applicationId)
    .run();
}

export async function markReportSubmitted(
  db: D1Database,
  reportMonth: string,
  externalReference?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reports
       SET status = 'submitted',
           submitted_at = CURRENT_TIMESTAMP,
           external_reference = COALESCE(?, external_reference),
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE report_month = ?`,
    )
    .bind(externalReference ?? null, reportMonth)
    .run();
}
