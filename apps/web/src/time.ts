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

export function isScheduledSafetyWindow(date = new Date()): boolean {
  const local = stockholmClock(date);
  return local.day === 14 && local.hour >= 10 && local.hour < 20;
}

export function nextSafetyWindowDescription(): string {
  return "den 14:e varje månad, 10:00–20:00 Europe/Stockholm";
}
