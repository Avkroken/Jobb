import type { ReportApplicationRow } from "./report-storage";

const STOCKHOLM_TZ = "Europe/Stockholm";
const JOB_ID_PREFIX = "Jobb-ID";

export function applicationDateForReport(
  iso: string,
  reportMonth: string,
): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("INVALID_APPLICATION_DATE: " + iso);
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STOCKHOLM_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const month = values.year + "-" + values.month;
  if (month !== reportMonth) {
    throw new Error(
      "APPLICATION_DATE_MONTH_MISMATCH: " +
        iso +
        " belongs to " +
        month +
        ", expected " +
        reportMonth +
        ".",
    );
  }
  return values.year + "-" + values.month + "-" + values.day;
}

export function employerReportValue(
  application: Pick<ReportApplicationRow, "employer" | "externalId">,
): string {
  const prefix = application.employer?.trim();
  return prefix
    ? prefix + " – " + JOB_ID_PREFIX + " " + application.externalId
    : JOB_ID_PREFIX + " " + application.externalId;
}

export function containsExactJobId(text: string, externalId: string): boolean {
  return new RegExp(
    "(?:^|\\D)" + escapeRegExp(externalId) + "(?:\\D|$)",
  ).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}
