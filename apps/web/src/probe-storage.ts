export interface IntegrationProbeRow {
  id: string;
  automation_run_id: string;
  integration: "arbetsformedlingen_activity_report";
  status: "captured" | "failed";
  page_url: string | null;
  object_key: string | null;
  summary_json: string | null;
  error_message: string | null;
  created_at: string;
}

export async function recordIntegrationProbe(
  db: D1Database,
  input: {
    id: string;
    runId: string;
    status: "captured" | "failed";
    pageUrl?: string;
    objectKey?: string;
    summary?: unknown;
    error?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO integration_probes
       (id, automation_run_id, integration, status, page_url, object_key,
        summary_json, error_message)
       VALUES (?, ?, 'arbetsformedlingen_activity_report', ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.runId,
      input.status,
      input.pageUrl ?? null,
      input.objectKey ?? null,
      input.summary === undefined ? null : JSON.stringify(input.summary),
      input.error ?? null,
    )
    .run();
}

export async function getLatestIntegrationProbe(
  db: D1Database,
  runId: string,
): Promise<IntegrationProbeRow | null> {
  return db
    .prepare(
      `SELECT * FROM integration_probes
       WHERE automation_run_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(runId)
    .first<IntegrationProbeRow>();
}
