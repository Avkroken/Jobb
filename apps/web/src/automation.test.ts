import { describe, expect, it } from "vitest";
import type { JobCandidate } from "../../../packages/core/src/types";
import { evaluateSuitability, suitabilityConfigured } from "./policy";
import {
  currentMonthKey,
  isActivityReportWindow,
  isApplicationAutomationWindow,
  isScheduledSafetyWindow,
  previousMonthKey,
} from "./time";

const job: JobCandidate = {
  provider: "studentconsulting",
  externalId: "87178",
  title: "IT-supporttekniker",
  employer: "StudentConsulting",
  location: "Stockholm",
  country: "Sverige",
  countryCode: "SE",
  isInternational: false,
  occupation: "IT / Support",
  sourceUrl:
    "https://www.studentconsulting.com/sv/lediga-jobb/stockholm/it-support/87178/",
};

describe("Stockholm automation window", () => {
  it("allows manual/application automation only from the 1st through the 14th", () => {
    expect(isApplicationAutomationWindow(new Date("2026-09-01T10:00:00Z"))).toBe(true);
    expect(isApplicationAutomationWindow(new Date("2026-09-14T10:00:00Z"))).toBe(true);
    expect(isApplicationAutomationWindow(new Date("2026-09-15T10:00:00Z"))).toBe(false);
    expect(isApplicationAutomationWindow(new Date("2026-09-30T10:00:00Z"))).toBe(false);
  });

  it("runs the autonomous fallback on the 10th-13th but never the 14th", () => {
    expect(isScheduledSafetyWindow(new Date("2026-09-10T09:00:00Z"))).toBe(true);
    expect(isScheduledSafetyWindow(new Date("2026-09-13T09:00:00Z"))).toBe(true);
    expect(isScheduledSafetyWindow(new Date("2026-09-14T09:00:00Z"))).toBe(false);
  });

  it("handles summer time without moving outside the local 10:00-20:00 window", () => {
    expect(isScheduledSafetyWindow(new Date("2026-07-10T08:00:00Z"))).toBe(true);
    expect(isScheduledSafetyWindow(new Date("2026-07-10T18:00:00Z"))).toBe(false);
  });

  it("handles winter time without moving outside the local 10:00-20:00 window", () => {
    expect(isScheduledSafetyWindow(new Date("2026-01-10T09:00:00Z"))).toBe(true);
    expect(isScheduledSafetyWindow(new Date("2026-01-10T19:00:00Z"))).toBe(false);
  });

  it("computes report and application months across year boundaries", () => {
    const january = new Date("2026-01-10T12:00:00Z");
    expect(currentMonthKey(january)).toBe("2026-01");
    expect(previousMonthKey(january)).toBe("2025-12");
    expect(isActivityReportWindow(january)).toBe(true);
  });
});

describe("suitability policy", () => {
  it("fails closed until include terms are configured", () => {
    expect(suitabilityConfigured({})).toBe(false);
    expect(evaluateSuitability({}, job).suitable).toBe(false);
  });

  it("accepts a matching allowed job", () => {
    const env = {
      JOB_INCLUDE_TERMS: "supporttekniker,helpdesk",
      JOB_ALLOWED_LOCATIONS: "Stockholm,Uppsala",
      JOB_ALLOWED_COUNTRIES: "SE",
    };
    expect(evaluateSuitability(env, job)).toEqual({ suitable: true, reasons: [] });
  });

  it("rejects excluded terms and disallowed countries", () => {
    expect(
      evaluateSuitability(
        {
          JOB_INCLUDE_TERMS: "support",
          JOB_EXCLUDE_TERMS: "senior",
          JOB_ALLOWED_COUNTRIES: "SE",
        },
        { ...job, title: "Senior IT-support", countryCode: "NO" },
      ).suitable,
    ).toBe(false);
  });
});
