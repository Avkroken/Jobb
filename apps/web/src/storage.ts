import type { JobCandidate } from "../../../packages/core/src/types";

export type RunMode = "manual" | "scheduled";
export type RunStatus = "running" | "needs_user_auth" | "completed" | "failed";

export interface AutomationRunRow {
  id: string;
  mode: RunMode;
  application_month: string;
  report_month: string;
  status: RunStatus;
  target_count: number;
  verified_count: number;
  workflow_instance_id: string | null;
  auth_session_id: string | null;
  auth_live_view_url: string | null;
  auth_expires_at: string | null;
  last_notified_at: string | null;
  last_error: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

export function scheduledRunId(applicationMonth: string): string {
  return `scheduled:${applicationMonth}`;
}

export async function createRun(
  db: D1Database,
  input: {
    id: string;
    mode: RunMode;
    applicationMonth: string;
    reportMonth: string;
    targetCount: number;
    workflowInstanceId?: string;
  },
): Promise<AutomationRunRow> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO automation_runs
       (id, mode, application_month, report_month, status, target_count, workflow_instance_id)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(
      input.id,
      input.mode,
      input.applicationMonth,
      input.reportMonth,
      input.targetCount,
      input.workflowInstanceId ?? null,
    )
    .run();

  if (input.workflowInstanceId) {
    await db
      .prepare(
        `UPDATE automation_runs
         SET workflow_instance_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(input.workflowInstanceId, input.id)
      .run();
  }

  const row = await getRun(db, input.id);
  if (!row) throw new Error("Failed to create automation run");
  return row;
}

export async function getRun(
  db: D1Database,
  id: string,
): Promise<AutomationRunRow | null> {
  return db
    .prepare("SELECT * FROM automation_runs WHERE id = ?")
    .bind(id)
    .first<AutomationRunRow>();
}

export async function updateRun(
  db: D1Database,
  id: string,
  patch: Partial<{
    status: RunStatus;
    verifiedCount: number;
    workflowInstanceId: string | null;
    authSessionId: string | null;
    authLiveViewUrl: string | null;
    authExpiresAt: string | null;
    lastNotifiedAt: string | null;
    lastError: string | null;
    completedAt: string | null;
  }>,
): Promise<void> {
  const assignments: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];

  const add = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.status !== undefined) add("status", patch.status);
  if (patch.verifiedCount !== undefined) add("verified_count", patch.verifiedCount);
  if (patch.workflowInstanceId !== undefined) add("workflow_instance_id", patch.workflowInstanceId);
  if (patch.authSessionId !== undefined) add("auth_session_id", patch.authSessionId);
  if (patch.authLiveViewUrl !== undefined) add("auth_live_view_url", patch.authLiveViewUrl);
  if (patch.authExpiresAt !== undefined) add("auth_expires_at", patch.authExpiresAt);
  if (patch.lastNotifiedAt !== undefined) add("last_notified_at", patch.lastNotifiedAt);
  if (patch.lastError !== undefined) add("last_error", patch.lastError);
  if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);

  values.push(id);
  await db
    .prepare(`UPDATE automation_runs SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function ensureReport(
  db: D1Database,
  month: string,
  targetCount: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO reports (id, report_month, target_count, status)
       VALUES (?, ?, ?, 'collecting')`,
    )
    .bind(`report:${month}`, month, targetCount)
    .run();
}

export async function setReportStatus(
  db: D1Database,
  month: string,
  status: "collecting" | "ready" | "needs_user_auth" | "submitting" | "submitted" | "failed",
  error: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reports
       SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE report_month = ?`,
    )
    .bind(status, error, month)
    .run();
}

export async function countVerifiedApplications(
  db: D1Database,
  month: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM applications
       WHERE report_month = ? AND status = 'verified'`,
    )
    .bind(month)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function hasApplicationForJob(
  db: D1Database,
  provider: string,
  externalId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT a.id
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE j.provider = ? AND j.external_id = ?
       LIMIT 1`,
    )
    .bind(provider, externalId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function persistJob(
  db: D1Database,
  job: JobCandidate,
): Promise<string> {
  const id = `${job.provider}:${job.externalId}`;
  await db
    .prepare(
      `INSERT INTO jobs
       (id, provider, external_id, title, employer, location, country_code,
        is_international, source_url, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, external_id) DO UPDATE SET
         title = excluded.title,
         employer = excluded.employer,
         location = excluded.location,
         country_code = excluded.country_code,
         is_international = excluded.is_international,
         source_url = excluded.source_url,
         raw_json = excluded.raw_json`,
    )
    .bind(
      id,
      job.provider,
      job.externalId,
      job.title,
      job.employer ?? null,
      job.location ?? null,
      job.countryCode ?? null,
      job.isInternational ? 1 : 0,
      job.sourceUrl,
      JSON.stringify(job),
    )
    .run();
  return id;
}

export async function createApplication(
  db: D1Database,
  input: {
    id: string;
    jobId: string;
    runId: string;
    reportMonth: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO applications
       (id, job_id, automation_run_id, status, report_month)
       VALUES (?, ?, ?, 'queued', ?)`,
    )
    .bind(input.id, input.jobId, input.runId, input.reportMonth)
    .run();
}

export async function setApplicationStatus(
  db: D1Database,
  id: string,
  status: "queued" | "applying" | "submitted" | "verified" | "failed" | "needs_user_action",
  options: { appliedAt?: string; verifiedAt?: string } = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE applications
       SET status = ?,
           applied_at = COALESCE(?, applied_at),
           verified_at = COALESCE(?, verified_at),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, options.appliedAt ?? null, options.verifiedAt ?? null, id)
    .run();
}

export async function nextAttemptNumber(
  db: D1Database,
  applicationId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM application_attempts WHERE application_id = ?",
    )
    .bind(applicationId)
    .first<{ next: number }>();
  return Number(row?.next ?? 1);
}

export async function startAttempt(
  db: D1Database,
  applicationId: string,
  attemptNo: number,
): Promise<string> {
  const id = `${applicationId}:attempt:${attemptNo}`;
  await db
    .prepare(
      `INSERT INTO application_attempts
       (id, application_id, attempt_no, status)
       VALUES (?, ?, ?, 'started')`,
    )
    .bind(id, applicationId, attemptNo)
    .run();
  return id;
}

export async function finishAttempt(
  db: D1Database,
  attemptId: string,
  status: "submitted" | "verified" | "failed" | "unknown",
  errorCode?: string,
  errorMessage?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE application_attempts
       SET status = ?, error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, errorCode ?? null, errorMessage ?? null, attemptId)
    .run();
}

export async function addEvidence(
  db: D1Database,
  input: { id: string; applicationId: string; kind: string; objectKey: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO evidence (id, application_id, kind, object_key)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.id, input.applicationId, input.kind, input.objectKey)
    .run();
}

export async function recordNotification(
  db: D1Database,
  input: {
    id: string;
    runId: string;
    kind: "bankid_required" | "run_failed" | "run_completed";
    channel: "email" | "webhook";
    status: "sent" | "failed";
    error?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications
       (id, automation_run_id, kind, channel, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.runId,
      input.kind,
      input.channel,
      input.status,
      input.error ?? null,
    )
    .run();
}
