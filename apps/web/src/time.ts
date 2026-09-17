const STOCKHOLM_TZ = "Europe/Stockholm";

export interface StockholmClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function stockholmClock(date = new Date()): StockholmClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STOCKHOLM_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function currentMonthKey(date = new Date()): string {
  const local = stockholmClock(date);
  return monthKey(local.year, local.month);
}

export function previousMonthKey(date = new Date()): string {
  const local = stockholmClock(date);
  const previous = new Date(Date.UTC(local.year, local.month - 2, 1));
  return monthKey(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
}

/** User-visible/manual automation is allowed only during AF's monthly reporting window. */
export function isApplicationAutomationWindow(date = new Date()): boolean {
  const local = stockholmClock(date);
  return local.day >= 1 && local.day <= 14;
}

export function isActivityReportWindow(date = new Date()): boolean {
  return isApplicationAutomationWindow(date);
}

/**
 * Low-traffic autonomous fallback: one invocation per day on the 10th–13th.
 * The Cron itself runs at 09:00 UTC, which is 10:00 CET or 11:00 CEST.
 */
export function isScheduledSafetyWindow(date = new Date()): boolean {
  const local = stockholmClock(date);
  return local.day >= 10 && local.day <= 13 && local.hour >= 10 && local.hour < 20;
}

export function nextSafetyWindowDescription(): string {
  return "10–13:e varje månad, en gång per dag mellan 10:00–20:00 Europe/Stockholm";
}
