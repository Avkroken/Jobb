import { describe, expect, it } from "vitest";
import {
  applicationDateForReport,
  containsExactJobId,
  employerReportValue,
} from "./report-data";

describe("activity report data invariants", () => {
  it("uses Europe/Stockholm when assigning the application month", () => {
    expect(
      applicationDateForReport("2026-08-31T22:30:00.000Z", "2026-09"),
    ).toBe("2026-09-01");
  });

  it("rejects attempts to move an application into another month", () => {
    expect(() =>
      applicationDateForReport("2026-09-15T10:00:00.000Z", "2026-08"),
    ).toThrow(/APPLICATION_DATE_MONTH_MISMATCH/);
  });

  it("requires an exact Jobb-ID boundary", () => {
    expect(containsExactJobId("Jobb-ID 87178", "87178")).toBe(true);
    expect(containsExactJobId("Jobb-ID 187178", "87178")).toBe(false);
  });

  it("keeps employer identity while including the requested Jobb-ID", () => {
    expect(
      employerReportValue({
        employer: "Exempel AB",
        externalId: "87178",
      }),
    ).toBe("Exempel AB – Jobb-ID 87178");
  });
});
