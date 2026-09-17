import type {
  ApplicationResult,
  AuthenticationState,
  CredentialsProvider,
  JobCandidate,
  JobProvider,
} from "../../core/src/types";
import type { BrowserLocator, BrowserPage } from "./browser";

const DEFAULT_BASE_URL = "https://www.studentconsulting.com";

export interface StudentConsultingDiscoverySource {
  url: string;
  country: string;
  countryCode: string;
  isInternational: boolean;
}

export interface StudentConsultingProviderOptions {
  page: BrowserPage;
  credentials: CredentialsProvider;
  baseUrl?: string;
  maxJobs?: number;
  maxPagesPerSource?: number;
  autoSubmit?: boolean;
  discoverySources?: StudentConsultingDiscoverySource[];
}

export interface ParsedStudentConsultingJob {
  externalId?: string;
  location?: string;
  occupation?: string;
}

export class StudentConsultingProvider implements JobProvider {
  readonly id = "studentconsulting" as const;

  private readonly page: BrowserPage;
  private readonly credentials: CredentialsProvider;
  private readonly baseUrl: string;
  private readonly maxJobs: number;
  private readonly maxPagesPerSource: number;
  private readonly autoSubmit: boolean;
  private readonly discoverySources: StudentConsultingDiscoverySource[];

  constructor(options: StudentConsultingProviderOptions) {
    this.page = options.page;
    this.credentials = options.credentials;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.maxJobs = options.maxJobs ?? 30;
    this.maxPagesPerSource = options.maxPagesPerSource ?? 3;
    this.autoSubmit = options.autoSubmit ?? false;
    this.discoverySources = options.discoverySources ?? [
      {
        url: `${this.baseUrl}/sv/lediga-jobb/norge?country=2`,
        country: "Norge",
        countryCode: "NO",
        isInternational: true,
      },
      {
        url: `${this.baseUrl}/sv/lediga-jobb/danmark?country=3`,
        country: "Danmark",
        countryCode: "DK",
        isInternational: true,
      },
      {
        url: `${this.baseUrl}/sv/lediga-jobb/`,
        country: "Sverige",
        countryCode: "SE",
        isInternational: false,
      },
    ];
  }

  async authenticate(): Promise<AuthenticationState> {
    try {
      const { username, password } =
        await this.credentials.getStudentConsultingCredentials();
      const redirectUrl = `${this.baseUrl}/sv/`;
      const loginUrl = `${this.baseUrl}/signin?language=sv-SE&redirectUrl=${encodeURIComponent(redirectUrl)}`;

      await this.page.goto(loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const email = await firstVisible(this.page, [
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[name="Email"]',
        'input[name="email"]',
      ]);
      const passwordInput = await firstVisible(this.page, [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
      ]);

      if (!email || !passwordInput) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_FORM_NOT_FOUND",
          message: "StudentConsulting login form could not be identified.",
        };
      }

      await email.fill(username);
      await passwordInput.fill(password);

      const submit = await firstVisible(this.page, [
        'button[type="submit"]',
        'input[type="submit"]',
      ]);

      if (!submit) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_SUBMIT_NOT_FOUND",
          message: "StudentConsulting login submit control could not be identified.",
        };
      }

      await submit.click({ timeout: 10_000 });
      await settleAfterNavigation(this.page, 20_000);

      const host = new URL(this.page.url()).hostname;
      if (host === "id.studentconsulting.com") {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_LOGIN_FAILED",
          message: "StudentConsulting did not establish an authenticated session.",
        };
      }

      if (!host.endsWith("studentconsulting.com")) {
        return {
          status: "failed",
          code: "STUDENTCONSULTING_UNEXPECTED_REDIRECT",
          message: `Unexpected login redirect host: ${host}`,
        };
      }

      return { status: "authenticated" };
    } catch (error) {
      return {
        status: "failed",
        code: "STUDENTCONSULTING_AUTH_ERROR",
        message: errorMessage(error),
      };
    }
  }

  async discover(): Promise<JobCandidate[]> {
    const candidates = new Map<string, JobCandidate>();

    for (const source of this.discoverySources) {
      for (let pageNumber = 1; pageNumber <= this.maxPagesPerSource; pageNumber += 1) {
        if (candidates.size >= this.maxJobs) break;

        const listingUrl = withPage(source.url, pageNumber);
        await this.page.goto(listingUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const links = await collectJobLinks(this.page, this.baseUrl);
        if (links.length === 0) break;

        let addedOnPage = 0;
        for (const sourceUrl of links) {
          if (candidates.size >= this.maxJobs) break;
          if (candidates.has(sourceUrl)) continue;

          const candidate = await this.readJob(sourceUrl, source);
          if (!candidate) continue;

          candidates.set(sourceUrl, candidate);
          addedOnPage += 1;
        }

        if (addedOnPage === 0) break;
      }
    }

    return [...candidates.values()].slice(0, this.maxJobs);
  }

  async apply(job: JobCandidate): Promise<ApplicationResult> {
    if (job.provider !== this.id) {
      return {
        status: "failed",
        error: "StudentConsulting provider received a job from another provider.",
      };
    }

    const auth = await this.authenticate();
    if (auth.status !== "authenticated") {
      return {
        status: "failed",
        error: auth.status === "failed" ? `${auth.code}: ${auth.message}` : "Authentication required.",
      };
    }

    await this.page.goto(job.sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const bodyText = await safeInnerText(this.page.locator("body").first());
    if (alreadyApplied(bodyText)) {
      return { status: "submitted", reference: job.externalId };
    }

    if (!this.autoSubmit) {
      return {
        status: "failed",
        error: "AUTOSUBMIT_DISABLED: set STUDENTCONSULTING_AUTOSUBMIT=true after validating the authenticated application form.",
      };
    }

    const requiredState = await validateRequiredControls(this.page);
    if (!requiredState.ok) {
      return { status: "failed", error: requiredState.error };
    }

    const submit = await findApplicationSubmit(this.page);
    if (!submit) {
      return {
        status: "failed",
        error: "APPLICATION_SUBMIT_NOT_FOUND: no unambiguous StudentConsulting application submit button was found.",
      };
    }

    await submit.click({ timeout: 10_000 });
    await settleAfterNavigation(this.page, 20_000);

    if (await this.verify(job)) {
      return { status: "submitted", reference: job.externalId };
    }

    return {
      status: "unknown",
      reference: job.externalId,
      error: "Submission was attempted but could not be verified in StudentConsulting applications.",
    };
  }

  async verify(job: JobCandidate): Promise<boolean> {
    try {
      await this.page.goto(`${this.baseUrl}/sv/`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const applicationsUrl = await findApplicationsUrl(this.page, this.baseUrl);
      if (!applicationsUrl) return false;

      await this.page.goto(applicationsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const bodyText = normalize(await safeInnerText(this.page.locator("body").first()));
      const title = normalize(job.title);
      return bodyText.includes(normalize(job.externalId)) || (title.length > 8 && bodyText.includes(title));
    } catch {
      return false;
    }
  }

  private async readJob(
    sourceUrl: string,
    source: StudentConsultingDiscoverySource,
  ): Promise<JobCandidate | null> {
    await this.page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const title = (await safeInnerText(this.page.locator("h1").first())).trim();
    const bodyText = await safeInnerText(this.page.locator("body").first());
    const parsed = parseStudentConsultingJobText(bodyText);

    if (!title || !parsed.externalId) return null;

    return {
      provider: this.id,
      externalId: parsed.externalId,
      title,
      employer: "StudentConsulting",
      location: parsed.location,
      country: source.country,
      countryCode: source.countryCode,
      isInternational: source.isInternational,
      occupation: parsed.occupation,
      applicationUrl: sourceUrl,
      sourceUrl,
    };
  }
}

export function parseStudentConsultingJobText(
  bodyText: string,
): ParsedStudentConsultingJob {
  const factsStart = bodyText.search(/Fakta om jobbet/i);
  const facts = factsStart >= 0 ? bodyText.slice(factsStart) : bodyText;
  const externalId = facts.match(/Jobb-ID\s*([0-9]+)/i)?.[1];

  return {
    externalId,
    location: readFact(facts, "Ort"),
    occupation: readFact(facts, "Yrkeskategori"),
  };
}

async function collectJobLinks(
  page: BrowserPage,
  baseUrl: string,
): Promise<string[]> {
  const anchors = page.locator('a[href*="/sv/lediga-jobb/"]');
  const count = Math.min(await anchors.count(), 250);
  const links = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const href = await anchors.nth(index).getAttribute("href");
    if (!href) continue;

    const url = new URL(href, baseUrl);
    if (!/\/sv\/lediga-jobb\/[^/]+\/[^/]+\/\d+\/?$/i.test(url.pathname)) continue;
    links.add(url.toString());
  }

  return [...links];
}

async function firstVisible(
  page: BrowserPage,
  selectors: string[],
): Promise<BrowserLocator | null> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count(), 10);
    for (let index = 0; index < count; index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return null;
}

async function validateRequiredControls(
  page: BrowserPage,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const controls = page.locator("input[required], textarea[required], select[required]");
  const count = Math.min(await controls.count(), 100);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;

    const type = ((await control.getAttribute("type")) ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (!(await control.isChecked())) {
        return {
          ok: false,
          error: "APPLICATION_REQUIRES_INPUT: a required checkbox or radio option is unresolved.",
        };
      }
      continue;
    }

    if (type === "file") {
      return {
        ok: false,
        error: "APPLICATION_REQUIRES_INPUT: a required file upload is unresolved.",
      };
    }

    if ((await control.inputValue()).trim() === "") {
      return {
        ok: false,
        error: "APPLICATION_REQUIRES_INPUT: a required application field is empty.",
      };
    }
  }

  return { ok: true };
}

async function findApplicationSubmit(
  page: BrowserPage,
): Promise<BrowserLocator | null> {
  const controls = page.locator('button, input[type="submit"]');
  const count = Math.min(await controls.count(), 100);
  const matches: BrowserLocator[] = [];
  const accepted = /^(skicka( in)? ansökan|sök tjänsten|sök jobbet|ansök)$/i;

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    const label = (
      (await safeInnerText(control)) ||
      (await control.getAttribute("value")) ||
      ""
    ).trim();
    if (accepted.test(label)) matches.push(control);
  }

  return matches.length === 1 ? matches[0] : null;
}

async function findApplicationsUrl(
  page: BrowserPage,
  baseUrl: string,
): Promise<string | null> {
  const anchors = page.locator("a");
  const count = Math.min(await anchors.count(), 300);
  const accepted = /^(ansökningar|applications|søknader|ansøgninger)$/i;

  for (let index = 0; index < count; index += 1) {
    const anchor = anchors.nth(index);
    if (!(await anchor.isVisible())) continue;
    const label = (await safeInnerText(anchor)).trim();
    if (!accepted.test(label)) continue;
    const href = await anchor.getAttribute("href");
    if (href) return new URL(href, baseUrl).toString();
  }

  return null;
}

function readFact(text: string, label: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLabel = normalize(label);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = normalize(line);
    if (normalizedLine === normalizedLabel) return lines[index + 1];
    if (normalizedLine.startsWith(normalizedLabel)) {
      const value = line.slice(label.length).trim();
      if (value) return value;
    }
  }

  return undefined;
}

function withPage(url: string, page: number): string {
  if (page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("page", String(page));
  return parsed.toString();
}

async function settleAfterNavigation(
  page: BrowserPage,
  timeout: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 });
    } catch {
      // A redirect may still be in progress.
    }
    if (new URL(page.url()).hostname !== "id.studentconsulting.com") return;
    await page.waitForTimeout(300);
  }
}

function alreadyApplied(text: string): boolean {
  return /redan sökt|already applied|allerede søkt|allerede søgt/i.test(text);
}

async function safeInnerText(locator: BrowserLocator): Promise<string> {
  try {
    return await locator.innerText();
  } catch {
    return "";
  }
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
