
import {
  connect,
  type BrowserWorker,
  type Locator,
  type Page,
} from "@cloudflare/playwright";
import type { JobCandidate } from "../../../packages/core/src/types";
import {
  isArbetsformedlingenAuthenticatedPage,
} from "./arbetsformedlingen-handoff";
import {
  navigateToActivityReport,
  safeInnerText,
  uniqueVisible,
  waitForActivityReportForm,
} from "./arbetsformedlingen-probe";
import { resolveOccupationConcept } from "./occupation";
import {
  applicationDateForReport,
  containsExactJobId,
  employerReportValue,
} from "./report-data";
import {
  ensureReportActivityItems,
  getReportActivityItem,
  loadVerifiedReportApplications,
  markReportSubmitted,
  setReportActivityItemState,
  type ReportApplicationRow,
} from "./report-storage";
import { setReportStatus } from "./storage";

const SETTLE_MS = 12_000;

export type ActivityReportSubmissionResult =
  | {
      status: "submitted";
      reportMonth: string;
      savedActivities: number;
      reference?: string;
    }
  | {
      status: "needs_user_action";
      reportMonth: string;
      savedActivities: number;
      issues: string[];
    }
  | {
      status: "unknown";
      reportMonth: string;
      savedActivities: number;
      error: string;
    }
  | {
      status: "failed";
      reportMonth: string;
      savedActivities: number;
      error: string;
    };

export interface ActivityReportAdapterEnv {
  DB: D1Database;
  BROWSER: BrowserWorker;
}

export async function submitArbetsformedlingenActivityReport(
  env: ActivityReportAdapterEnv,
  sessionId: string,
  reportMonth: string,
): Promise<ActivityReportSubmissionResult> {
  const applications = await loadVerifiedReportApplications(env.DB, reportMonth);
  validateApplicationDates(applications, reportMonth);
  await ensureReportActivityItems(env.DB, reportMonth, applications);

  const reportState = await env.DB
    .prepare("SELECT status FROM reports WHERE report_month = ?")
    .bind(reportMonth)
    .first<{ status: string }>();

  const browser = await connect(env.BROWSER, sessionId);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    if (!(await isArbetsformedlingenAuthenticatedPage(page))) {
      return {
        status: "needs_user_action",
        reportMonth,
        savedActivities: await countSavedItems(env.DB, reportMonth),
        issues: ["Arbetsförmedlingen-sessionen är inte längre autentiserad."],
      };
    }

    await navigateToActivityReport(page);

    if (reportState?.status === "submitting") {
      const confirmation = await verifyReportSubmissionConfirmation(page);
      if (confirmation.confirmed) {
        await markReportSubmitted(env.DB, reportMonth, confirmation.reference);
        return {
          status: "submitted",
          reportMonth,
          savedActivities: await countSavedItems(env.DB, reportMonth),
          reference: confirmation.reference,
        };
      }
      return {
        status: "unknown",
        reportMonth,
        savedActivities: await countSavedItems(env.DB, reportMonth),
        error:
          "REPORT_SUBMISSION_UNCERTAIN: rapporten hade redan markerats som submitting men någon säker bekräftelse kunde inte hittas. Ingen ny Skicka in-klickning görs.",
      };
    }

    for (const application of applications) {
      const current = await getReportActivityItem(
        env.DB,
        reportMonth,
        application.applicationId,
      );
      if (!current) {
        return {
          status: "failed",
          reportMonth,
          savedActivities: await countSavedItems(env.DB, reportMonth),
          error:
            "REPORT_ITEM_MISSING: D1-raden saknas för Jobb-ID " +
            application.externalId +
            ".",
        };
      }
      if (current.state === "saved") continue;

      await navigateToActivityReport(page);

      if (await pageContainsExactJobId(page, application.externalId)) {
        await setReportActivityItemState(
          env.DB,
          reportMonth,
          application.applicationId,
          "saved",
        );
        continue;
      }

      if (current.state === "save_attempted") {
        return {
          status: "unknown",
          reportMonth,
          savedActivities: await countSavedItems(env.DB, reportMonth),
          error:
            "ACTIVITY_SAVE_UNCERTAIN: Spara hade redan aktiverats för Jobb-ID " +
            application.externalId +
            ", men posten kan inte verifieras i rapporten. Ingen ny Spara-klickning görs.",
        };
      }

      const save = await fillAndSaveActivity(
        env.DB,
        page,
        reportMonth,
        application,
      );
      if (save.status === "needs_user_action") {
        return {
          status: "needs_user_action",
          reportMonth,
          savedActivities: await countSavedItems(env.DB, reportMonth),
          issues: save.issues,
        };
      }
      if (save.status === "unknown") {
        return {
          status: "unknown",
          reportMonth,
          savedActivities: await countSavedItems(env.DB, reportMonth),
          error: save.error,
        };
      }
      if (save.status === "failed") {
        return {
          status: "failed",
          reportMonth,
          savedActivities: await countSavedItems(env.DB, reportMonth),
          error: save.error,
        };
      }
    }

    const savedActivities = await countSavedItems(env.DB, reportMonth);
    if (savedActivities !== applications.length) {
      return {
        status: "failed",
        reportMonth,
        savedActivities,
        error:
          "REPORT_SAVE_COUNT_MISMATCH: " +
          savedActivities +
          "/" +
          applications.length +
          " aktiviteter är verifierat sparade.",
      };
    }

    await navigateToActivityReport(page);
    const issues = await findUnresolvedMandatoryQuestions(page);
    if (issues.length > 0) {
      await setReportStatus(
        env.DB,
        reportMonth,
        "needs_user_auth",
        issues.join(" | "),
      );
      return {
        status: "needs_user_action",
        reportMonth,
        savedActivities,
        issues,
      };
    }

    const submit = await findUniqueSubmitReportControl(page);
    if (!submit) {
      return {
        status: "needs_user_action",
        reportMonth,
        savedActivities,
        issues: [
          "REPORT_SUBMIT_NOT_FOUND: kunde inte identifiera en entydig knapp för att skicka in aktivitetsrapporten.",
        ],
      };
    }

    await setReportStatus(env.DB, reportMonth, "submitting");

    try {
      await submit.click({ timeout: 10_000 });
    } catch (error) {
      return {
        status: "unknown",
        reportMonth,
        savedActivities,
        error:
          "REPORT_SUBMISSION_UNCERTAIN: Skicka in aktiverades men navigeringen gav fel: " +
          errorMessage(error),
      };
    }

    await settle(page);
    const confirmation = await verifyReportSubmissionConfirmation(page);
    if (!confirmation.confirmed) {
      return {
        status: "unknown",
        reportMonth,
        savedActivities,
        error:
          "REPORT_SUBMISSION_UNCERTAIN: Skicka in aktiverades men ingen säker bekräftelse hittades. Nästa kontroll verifierar bara resultatet och skickar inte igen.",
      };
    }

    await markReportSubmitted(env.DB, reportMonth, confirmation.reference);
    return {
      status: "submitted",
      reportMonth,
      savedActivities,
      reference: confirmation.reference,
    };
  } catch (error) {
    return {
      status: "failed",
      reportMonth,
      savedActivities: await countSavedItems(env.DB, reportMonth),
      error: errorMessage(error),
    };
  } finally {
    await browser.close();
  }
}

async function fillAndSaveActivity(
  db: D1Database,
  page: Page,
  reportMonth: string,
  application: ReportApplicationRow,
): Promise<
  | { status: "saved" }
  | { status: "needs_user_action"; issues: string[] }
  | { status: "unknown"; error: string }
  | { status: "failed"; error: string }
> {
  await waitForActivityReportForm(page);

  const activityTypeIssue = await ensureSearchedJobActivityType(page);
  if (activityTypeIssue) {
    return { status: "needs_user_action", issues: [activityTypeIssue] };
  }

  const rawJob = parseJob(application.rawJson);
  const occupationText =
    rawJob?.occupation?.trim() || application.title.trim();
  const occupation = await resolveOccupationConcept(occupationText);
  if (!occupation) {
    return {
      status: "needs_user_action",
      issues: [
        "OCCUPATION_AMBIGUOUS: kunde inte mappa “" +
          occupationText +
          "” entydigt till Arbetsförmedlingens yrkeslista för Jobb-ID " +
          application.externalId +
          ".",
      ],
    };
  }

  const appliedDate = applicationDateForReport(
    application.appliedAt,
    reportMonth,
  );

  const date = await findSemanticField(page, [
    /datum.*(sökt|ansökan|aktivitet)/i,
    /när.*sökte/i,
    /^datum$/i,
  ]);
  if (!date) {
    return {
      status: "needs_user_action",
      issues: ["DATE_FIELD_NOT_FOUND: kunde inte identifiera datumfältet."],
    };
  }
  await date.fill(appliedDate);

  const employer = await findSemanticField(page, [
    /arbetsgivare/i,
    /företag/i,
    /organisation/i,
  ]);
  if (!employer) {
    return {
      status: "needs_user_action",
      issues: [
        "EMPLOYER_FIELD_NOT_FOUND: kunde inte identifiera arbetsgivar-/företagsfältet.",
      ],
    };
  }
  await employer.fill(employerReportValue(application));

  const occupationField = await findSemanticField(page, [
    /yrke/i,
    /befattning/i,
    /occupation/i,
  ]);
  if (!occupationField) {
    return {
      status: "needs_user_action",
      issues: ["OCCUPATION_FIELD_NOT_FOUND: kunde inte identifiera yrkesfältet."],
    };
  }
  const occupationSet = await fillStructuredField(
    page,
    occupationField,
    occupation.label,
  );
  if (!occupationSet) {
    return {
      status: "needs_user_action",
      issues: [
        "OCCUPATION_OPTION_NOT_FOUND: yrket “" +
          occupation.label +
          "” kunde inte väljas entydigt.",
      ],
    };
  }

  if (application.isInternational || application.countryCode !== "SE") {
    const outside = await chooseSemanticChoice(page, [
      /utanför sverige/i,
      /utomlands/i,
      /annat land/i,
    ]);
    if (!outside) {
      return {
        status: "needs_user_action",
        issues: [
          "INTERNATIONAL_CHOICE_NOT_FOUND: Jobb-ID " +
            application.externalId +
            " är utanför Sverige men rätt markering kunde inte väljas.",
        ],
      };
    }
  } else {
    const locationText = application.location?.trim();
    if (!locationText) {
      return {
        status: "needs_user_action",
        issues: [
          "LOCATION_MISSING: svensk annons Jobb-ID " +
            application.externalId +
            " saknar ort.",
        ],
      };
    }

    const locationField = await findSemanticField(page, [
      /ort/i,
      /plats/i,
      /kommun/i,
    ]);
    if (!locationField) {
      return {
        status: "needs_user_action",
        issues: [
          "LOCATION_FIELD_NOT_FOUND: kunde inte identifiera ortsfältet.",
        ],
      };
    }

    const locationSet = await fillStructuredField(
      page,
      locationField,
      locationText,
    );
    if (!locationSet) {
      return {
        status: "needs_user_action",
        issues: [
          "LOCATION_OPTION_NOT_FOUND: orten “" +
            locationText +
            "” kunde inte väljas entydigt.",
        ],
      };
    }
  }

  const unresolved = await findRequiredFieldsInCurrentForm(page);
  if (unresolved.length > 0) {
    return { status: "needs_user_action", issues: unresolved };
  }

  const save = await findUniqueSaveActivityControl(page);
  if (!save) {
    return {
      status: "needs_user_action",
      issues: [
        "ACTIVITY_SAVE_NOT_FOUND: kunde inte identifiera en entydig Spara-knapp för aktiviteten.",
      ],
    };
  }

  await setReportActivityItemState(
    db,
    reportMonth,
    application.applicationId,
    "save_attempted",
  );

  try {
    await save.click({ timeout: 10_000 });
  } catch (error) {
    return {
      status: "unknown",
      error:
        "ACTIVITY_SAVE_UNCERTAIN: Spara aktiverades men navigeringen gav fel: " +
        errorMessage(error),
    };
  }

  await settle(page);
  await navigateToActivityReport(page);
  if (!(await pageContainsExactJobId(page, application.externalId))) {
    return {
      status: "unknown",
      error:
        "ACTIVITY_SAVE_UNCERTAIN: Jobb-ID " +
        application.externalId +
        " kunde inte verifieras efter Spara. Ingen automatisk omsparning görs.",
    };
  }

  await setReportActivityItemState(
    db,
    reportMonth,
    application.applicationId,
    "saved",
  );
  return { status: "saved" };
}

async function ensureSearchedJobActivityType(
  page: Page,
): Promise<string | null> {
  const selected = await chooseSemanticChoice(page, [
    /^sökt jobb$/i,
    /jag har sökt.*jobb/i,
    /sökt.*arbete/i,
  ]);
  if (selected) {
    await page.waitForTimeout(300);
    return null;
  }

  const main = await safeInnerText(page.locator("main").first());
  if (/sökt jobb|sökt.*arbete/i.test(main)) return null;

  return "ACTIVITY_TYPE_NOT_FOUND: kunde inte välja aktivitetstypen “Sökt jobb”.";
}

async function findSemanticField(
  page: Page,
  patterns: RegExp[],
): Promise<Locator | null> {
  const candidates: Locator[] = [];
  const controls = page.locator(
    "input:not([type='hidden']):not([type='radio']):not([type='checkbox']), select, textarea",
  );
  const count = Math.min(await controls.count(), 200);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;

    const descriptors = [
      await control.getAttribute("name"),
      await control.getAttribute("id"),
      await control.getAttribute("aria-label"),
      await control.getAttribute("placeholder"),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");

    const id = await control.getAttribute("id");
    let labelText = "";
    if (id) {
      labelText = await safeInnerText(
        page.locator('label[for="' + cssEscape(id) + '"]').first(),
      );
    }

    if (
      patterns.some((pattern) =>
        pattern.test(labelText + " " + descriptors),
      )
    ) {
      candidates.push(control);
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function fillStructuredField(
  page: Page,
  field: Locator,
  value: string,
): Promise<boolean> {
  const nativeOptions = field.locator("option");
  if ((await nativeOptions.count()) > 0) {
    try {
      await field.selectOption({ label: value });
      return true;
    } catch {
      return false;
    }
  }

  await field.fill(value);

  await page.waitForTimeout(350);

  const exact = await uniqueVisible(
    page.getByRole("option", { name: value, exact: true }),
    30,
  );
  if (exact) {
    await exact.click({ timeout: 5_000 });
    return true;
  }

  const candidate = await uniqueVisible(
    page.getByRole("option", {
      name: new RegExp("^" + escapeRegExp(value) + "$", "i"),
    }),
    30,
  );
  if (!candidate) return false;
  await candidate.click({ timeout: 5_000 });
  return true;
}

async function chooseSemanticChoice(
  page: Page,
  patterns: RegExp[],
): Promise<boolean> {
  for (const pattern of patterns) {
    const radio = await uniqueVisible(
      page.getByRole("radio", { name: pattern }),
      30,
    );
    if (radio) {
      if (!(await radio.isChecked())) await radio.click({ timeout: 5_000 });
      return true;
    }

    const checkbox = await uniqueVisible(
      page.getByRole("checkbox", { name: pattern }),
      30,
    );
    if (checkbox) {
      if (!(await checkbox.isChecked())) {
        await checkbox.click({ timeout: 5_000 });
      }
      return true;
    }

    const option = await uniqueVisible(
      page.getByRole("option", { name: pattern }),
      30,
    );
    if (option) {
      await option.click({ timeout: 5_000 });
      return true;
    }
  }
  return false;
}

async function findRequiredFieldsInCurrentForm(
  page: Page,
): Promise<string[]> {
  const issues: string[] = [];

  const textControls = page.locator(
    "input[required]:not([type='hidden']):not([type='radio']):not([type='checkbox']), select[required], textarea[required], input[aria-required='true']:not([type='hidden']):not([type='radio']):not([type='checkbox']), select[aria-required='true'], textarea[aria-required='true']",
  );
  const count = Math.min(await textControls.count(), 100);
  for (let index = 0; index < count; index += 1) {
    const control = textControls.nth(index);
    if (!(await control.isVisible())) continue;
    const value = (await control.inputValue()).trim();
    if (value) continue;
    issues.push(
      "REQUIRED_FIELD_EMPTY: " +
        (await describeControl(page, control)),
    );
  }

  const choiceControls = page.locator(
    "input[type='checkbox'][required], input[type='checkbox'][aria-required='true']",
  );
  const choiceCount = Math.min(await choiceControls.count(), 100);
  for (let index = 0; index < choiceCount; index += 1) {
    const control = choiceControls.nth(index);
    if (!(await control.isVisible())) continue;
    if (!(await control.isChecked())) {
      issues.push(
        "REQUIRED_CHECKBOX_UNRESOLVED: " +
          (await describeControl(page, control)),
      );
    }
  }

  const radioGroups = new Set<string>();
  const radios = page.locator(
    "input[type='radio'][required], input[type='radio'][aria-required='true']",
  );
  const radioCount = Math.min(await radios.count(), 100);
  for (let index = 0; index < radioCount; index += 1) {
    const radio = radios.nth(index);
    if (!(await radio.isVisible())) continue;
    const name = await radio.getAttribute("name");
    if (name) radioGroups.add(name);
  }
  for (const name of radioGroups) {
    const group = page.locator(
      'input[type="radio"][name="' + cssEscape(name) + '"]',
    );
    const groupCount = Math.min(await group.count(), 50);
    let checked = false;
    for (let index = 0; index < groupCount; index += 1) {
      if (await group.nth(index).isChecked()) {
        checked = true;
        break;
      }
    }
    if (!checked) issues.push("REQUIRED_RADIO_UNRESOLVED: " + name);
  }

  return [...new Set(issues)];
}

async function findUnresolvedMandatoryQuestions(
  page: Page,
): Promise<string[]> {
  const issues = await findRequiredFieldsInCurrentForm(page);

  const fieldsets = page.locator("fieldset");
  const count = Math.min(await fieldsets.count(), 100);
  for (let index = 0; index < count; index += 1) {
    const fieldset = fieldsets.nth(index);
    if (!(await fieldset.isVisible())) continue;
    const text = (await safeInnerText(fieldset)).trim();
    if (
      !/obligatorisk|handlingsplan|rekommenderad aktivitet/i.test(text) &&
      !text.endsWith("?")
    ) {
      continue;
    }

    const radios = fieldset.locator("input[type='radio']");
    const radioCount = Math.min(await radios.count(), 50);
    if (radioCount > 0) {
      let checked = false;
      for (let radioIndex = 0; radioIndex < radioCount; radioIndex += 1) {
        if (await radios.nth(radioIndex).isChecked()) {
          checked = true;
          break;
        }
      }
      if (!checked) {
        issues.push(
          "MANDATORY_QUESTION_UNANSWERED: " +
            text.replace(/\s+/g, " ").slice(0, 300),
        );
      }
    }
  }

  return [...new Set(issues)];
}

async function findUniqueSaveActivityControl(
  page: Page,
): Promise<Locator | null> {
  for (const pattern of [
    /^spara$/i,
    /spara.*aktivitet/i,
    /lägg till.*aktivitet/i,
  ]) {
    const candidate = await uniqueVisible(
      page.getByRole("button", { name: pattern }),
      30,
    );
    if (candidate) return candidate;
  }
  return null;
}

async function findUniqueSubmitReportControl(
  page: Page,
): Promise<Locator | null> {
  for (const pattern of [
    /skicka in.*aktivitetsrapport/i,
    /skicka in.*rapport/i,
    /^skicka in$/i,
    /lämna in.*rapport/i,
  ]) {
    const candidate = await uniqueVisible(
      page.getByRole("button", { name: pattern }),
      30,
    );
    if (candidate) return candidate;
  }
  return null;
}

async function pageContainsExactJobId(
  page: Page,
  externalId: string,
): Promise<boolean> {
  const text = await safeInnerText(page.locator("main").first());
  return containsExactJobId(text, externalId);
}

async function verifyReportSubmissionConfirmation(
  page: Page,
): Promise<{ confirmed: boolean; reference?: string }> {
  await settle(page);
  if (!(await isArbetsformedlingenAuthenticatedPage(page))) {
    return { confirmed: false };
  }

  const text = await safeInnerText(page.locator("main").first());
  const confirmed =
    /aktivitetsrapport(?:en)?.*(?:inskickad|skickats in|mottagen)|tack.*aktivitetsrapport|rapporten är inskickad/i.test(
      text,
    );
  if (!confirmed) return { confirmed: false };

  const reference = text.match(
    /(?:referens|kvittens|ärende(?:nummer)?)[\s:#-]*([A-Z0-9-]{4,})/i,
  )?.[1];
  return { confirmed: true, reference };
}

function validateApplicationDates(
  applications: ReportApplicationRow[],
  reportMonth: string,
): void {
  for (const application of applications) {
    applicationDateForReport(application.appliedAt, reportMonth);
  }
}


function parseJob(rawJson: string | null): JobCandidate | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as JobCandidate;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function countSavedItems(
  db: D1Database,
  reportMonth: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM report_activity_items WHERE report_month = ? AND state = 'saved'",
    )
    .bind(reportMonth)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function describeControl(
  page: Page,
  control: Locator,
): Promise<string> {
  const id = await control.getAttribute("id");
  const label = id
    ? await safeInnerText(
        page.locator('label[for="' + cssEscape(id) + '"]').first(),
      )
    : "";
  return (
    label ||
    (await control.getAttribute("aria-label")) ||
    (await control.getAttribute("name")) ||
    (await control.getAttribute("placeholder")) ||
    "okänt obligatoriskt fält"
  )
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

async function settle(page: Page): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 1_000 });
      return;
    } catch {
      await page.waitForTimeout(250);
    }
  }
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
