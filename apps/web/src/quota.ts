import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";

export type MonthlySlotState =
  | "free"
  | "reserved"
  | "submitted"
  | "verified"
  | "uncertain";

export interface MonthlySlotClaim {
  reportMonth: string;
  slotNo: number;
  applicationId: string;
  state: MonthlySlotState;
}

export async function ensureMonthlyApplicationSlots(
  db: D1Database,
  reportMonth: string,
): Promise<void> {
  const statements = Array.from(
    { length: MONTHLY_APPLICATION_TARGET },
    (_, index) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO monthly_application_slots
           (report_month, slot_no, state)
           VALUES (?, ?, 'free')`,
        )
        .bind(reportMonth, index + 1),
  );
  await db.batch(statements);
}

/**
 * Reserve one of exactly ten monthly slots before any submit side effect.
 * D1 serializes the write statement; the follow-up SELECT confirms whether
 * this application won a slot. A previously claimed application is idempotent.
 */
export async function claimMonthlyApplicationSlot(
  db: D1Database,
  reportMonth: string,
  applicationId: string,
): Promise<MonthlySlotClaim | null> {
  await ensureMonthlyApplicationSlots(db, reportMonth);

  const existing = await getSlotForApplication(db, applicationId);
  if (existing) return existing;

  await db
    .prepare(
      `UPDATE monthly_application_slots
       SET application_id = ?, state = 'reserved', updated_at = CURRENT_TIMESTAMP
       WHERE report_month = ?
         AND slot_no = (
           SELECT slot_no
           FROM monthly_application_slots
           WHERE report_month = ? AND state = 'free' AND application_id IS NULL
           ORDER BY slot_no
           LIMIT 1
         )
         AND state = 'free'
         AND application_id IS NULL`,
    )
    .bind(applicationId, reportMonth, reportMonth)
    .run();

  return getSlotForApplication(db, applicationId);
}

export async function setMonthlyApplicationSlotState(
  db: D1Database,
  applicationId: string,
  state: Exclude<MonthlySlotState, "free">,
): Promise<void> {
  await db
    .prepare(
      `UPDATE monthly_application_slots
       SET state = ?, updated_at = CURRENT_TIMESTAMP
       WHERE application_id = ?`,
    )
    .bind(state, applicationId)
    .run();
}

/** Release only a reservation that is known not to have submitted anything. */
export async function releaseMonthlyApplicationSlot(
  db: D1Database,
  applicationId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE monthly_application_slots
       SET application_id = NULL, state = 'free', updated_at = CURRENT_TIMESTAMP
       WHERE application_id = ? AND state = 'reserved'`,
    )
    .bind(applicationId)
    .run();
}

export async function countOccupiedMonthlyApplicationSlots(
  db: D1Database,
  reportMonth: string,
): Promise<number> {
  await ensureMonthlyApplicationSlots(db, reportMonth);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM monthly_application_slots
       WHERE report_month = ? AND state <> 'free'`,
    )
    .bind(reportMonth)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function getSlotForApplication(
  db: D1Database,
  applicationId: string,
): Promise<MonthlySlotClaim | null> {
  const row = await db
    .prepare(
      `SELECT report_month, slot_no, application_id, state
       FROM monthly_application_slots
       WHERE application_id = ?
       LIMIT 1`,
    )
    .bind(applicationId)
    .first<{
      report_month: string;
      slot_no: number;
      application_id: string;
      state: MonthlySlotState;
    }>();

  return row
    ? {
        reportMonth: row.report_month,
        slotNo: Number(row.slot_no),
        applicationId: row.application_id,
        state: row.state,
      }
    : null;
}
