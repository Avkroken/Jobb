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
  reservationOwner: string;
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

  // A crash before the application row is created cannot have reached submit,
  // so abandoned pre-submit reservations can safely be reclaimed after an hour.
  await db
    .prepare(
      `UPDATE monthly_application_slots
       SET application_id = NULL,
           reservation_owner = NULL,
           state = 'free',
           updated_at = CURRENT_TIMESTAMP
       WHERE report_month = ?
         AND state = 'reserved'
         AND application_id IS NOT NULL
         AND updated_at < datetime('now', '-1 hour')
         AND NOT EXISTS (
           SELECT 1 FROM applications a
           WHERE a.id = monthly_application_slots.application_id
         )`,
    )
    .bind(reportMonth)
    .run();
}

/**
 * Reserve one of exactly ten monthly slots before any submit side effect.
 * reservationOwner is unique per application attempt so overlapping workflows
 * can never release or mutate another attempt's slot.
 */
export async function claimMonthlyApplicationSlot(
  db: D1Database,
  reportMonth: string,
  applicationId: string,
  reservationOwner: string,
): Promise<MonthlySlotClaim | null> {
  await ensureMonthlyApplicationSlots(db, reportMonth);

  const existing = await getSlotForApplication(db, applicationId);
  if (existing) {
    return existing.reportMonth === reportMonth &&
      existing.reservationOwner === reservationOwner
      ? existing
      : null;
  }

  try {
    await db
      .prepare(
        `UPDATE monthly_application_slots
         SET application_id = ?,
             reservation_owner = ?,
             state = 'reserved',
             updated_at = CURRENT_TIMESTAMP
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
      .bind(applicationId, reservationOwner, reportMonth, reportMonth)
      .run();
  } catch {
    // A concurrent claimant may have won either the same application_id or
    // the selected slot. Read the winner below instead of propagating the race.
  }

  const won = await getSlotForApplication(db, applicationId);
  return won &&
    won.reportMonth === reportMonth &&
    won.reservationOwner === reservationOwner
    ? won
    : null;
}

export async function setOwnedMonthlyApplicationSlotState(
  db: D1Database,
  applicationId: string,
  reservationOwner: string,
  state: Exclude<MonthlySlotState, "free" | "reserved">,
): Promise<void> {
  await db
    .prepare(
      `UPDATE monthly_application_slots
       SET state = ?, updated_at = CURRENT_TIMESTAMP
       WHERE application_id = ? AND reservation_owner = ?`,
    )
    .bind(state, applicationId, reservationOwner)
    .run();
}

export async function reconcileMonthlyApplicationSlotState(
  db: D1Database,
  applicationId: string,
  state: "submitted" | "verified" | "uncertain",
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

/** Release only the reservation owned by this exact application attempt. */
export async function releaseMonthlyApplicationSlot(
  db: D1Database,
  applicationId: string,
  reservationOwner: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE monthly_application_slots
       SET application_id = NULL,
           reservation_owner = NULL,
           state = 'free',
           updated_at = CURRENT_TIMESTAMP
       WHERE application_id = ?
         AND reservation_owner = ?
         AND state = 'reserved'`,
    )
    .bind(applicationId, reservationOwner)
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
      `SELECT report_month, slot_no, application_id, reservation_owner, state
       FROM monthly_application_slots
       WHERE application_id = ?
       LIMIT 1`,
    )
    .bind(applicationId)
    .first<{
      report_month: string;
      slot_no: number;
      application_id: string;
      reservation_owner: string | null;
      state: MonthlySlotState;
    }>();

  return row && row.reservation_owner
    ? {
        reportMonth: row.report_month,
        slotNo: Number(row.slot_no),
        applicationId: row.application_id,
        reservationOwner: row.reservation_owner,
        state: row.state,
      }
    : null;
}
