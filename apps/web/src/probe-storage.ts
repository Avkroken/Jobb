const INTEGRATION = "arbetsformedlingen_activity_report" as const;

export interface IntegrationProbeRow {
  id: string;
  automation_run_id: string;
  integration: typeof INTEGRATION;
  status: "capturing" | "captured" | "failed";
  page_url: string | null;
  object_key: string | null;
  summary_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function reserveIntegrationProbe(
  db: D1Database,
  runId: string,
): Promise<{ acquired: boolean; probe: IntegrationProbeRow }> {
  const id = `probe:${runId}:${INTEGRATION}`;
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO integration_probes
       (id, automation_run_id, integration, status)
       VALUES (?, ?, ?, 'capturing')`,
    )
    .bind(id, runId, INTEGRATION)
    .run();

  if ((inserted.meta.changes ?? 0) > 0) {
    const probe = await getIntegrationProbe(db, runId);
    if (!probe) throw new Error("Integration probe reservation disappeared after insert.");
    return { acquired: true, probe };
  }

  const retried = await db
    .prepare(
      `UPDATE integration_probes
       SET status = 'capturing', page_url = NULL, object_key = NULL,
           summary_json = NULL, error_message = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE automation_run_id = ? AND integration = ?
         AND (
           status = 'failed'
           OR (status = 'capturing' AND updated_at < datetime('now', '-2 minutes'))
         )`,
    )
    .bind(runId, INTEGRATION)
    .run();

  const probe = await getIntegrationProbe(db, runId);
  if (!probe) throw new Error("Integration probe reservation could not be loaded.");
  return { acquired: (retried.meta.changes ?? 0) > 0, probe };
}

export async function completeIntegrationProbe(
  db: D1Database,
  input: {
    id: string;
    status: "captured" | "failed";
    pageUrl?: string;
    objectKey?: string;
    summary?: unknown;
    error?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE integration_probes
       SET status = ?, page_url = ?, object_key = ?, summary_json = ?,
           error_message = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(
      input.status,
      input.pageUrl ?? null,
      input.objectKey ?? null,
      input.summary === undefined ? null : JSON.stringify(input.summary),
      input.error ?? null,
      input.id,
    )
    .run();
}

export async function getIntegrationProbe(
  db: D1Database,
  runId: string,
): Promise<IntegrationProbeRow | null> {
  return db
    .prepare(
      `SELECT * FROM integration_probes
       WHERE automation_run_id = ? AND integration = ?
       LIMIT 1`,
    )
    .bind(runId, INTEGRATION)
    .first<IntegrationProbeRow>();
}
