import {
  connect,
  type BrowserWorker,
  type Locator,
  type Page,
} from "@cloudflare/playwright";
import {
  isArbetsformedlingenAuthenticatedPage,
  sanitizeArbetsformedlingenBrowserUrl,
} from "./arbetsformedlingen-handoff";

export interface ActivityReportControlProbe {
  tag: "input" | "select" | "textarea" | "button" | "a";
  type?: string;
  name?: string;
  id?: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  text?: string;
  href?: string;
  options?: string[];
}

export interface ActivityReportProbe {
  pageUrl: string;
  headings: string[];
  controls: ActivityReportControlProbe[];
  mandatoryQuestionCandidates: string[];
  capturedAt: string;
}

export async function captureArbetsformedlingenActivityReportProbe(
  binding: BrowserWorker,
  sessionId: string,
): Promise<ActivityReportProbe> {
  const browser = await connect(binding, sessionId);

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    if (!(await isArbetsformedlingenAuthenticatedPage(page))) {
      throw new Error("Arbetsförmedlingen session is not authenticated.");
    }

    await navigateToActivityReport(page);
    await waitForActivityReportForm(page);

    const headings = await collectTexts(page.locator("h1, h2, h3"), 80);
    const controls: ActivityReportControlProbe[] = [];

    controls.push(...(await collectControls(page, "input", 200)));
    controls.push(...(await collectControls(page, "select", 100)));
    controls.push(...(await collectControls(page, "textarea", 100)));
    controls.push(...(await collectControls(page, "button", 150)));
    controls.push(...(await collectControls(page, "a", 250)));

    if (!controls.some((control) => ["input", "select", "textarea"].includes(control.tag))) {
      throw new Error("Activity-report form has no meaningful input controls; refusing to persist an empty probe.");
    }

    const visibleText = await safeInnerText(page.locator("main").first());
    const questionCandidates = visibleText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => /\?$/.test(line) || /obligatorisk|rekommenderad aktivitet/i.test(line))
      .slice(0, 100);

    return {
      pageUrl: sanitizeArbetsformedlingenBrowserUrl(page.url()),
      headings,
      controls,
      mandatoryQuestionCandidates: [...new Set(questionCandidates)],
      capturedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

export async function navigateToActivityReport(page: Page): Promise<void> {
  if (/aktivitetsrapport/i.test(page.url())) return;

  const linkCandidates = page.getByRole("link", {
    name: /aktivitetsrapport|rapportera.*aktivitet/i,
  });
  const link = await uniqueVisible(linkCandidates, 20);
  if (link) {
    await link.click({ timeout: 10_000 });
    return;
  }

  const buttonCandidates = page.getByRole("button", {
    name: /aktivitetsrapport|rapportera.*aktivitet/i,
  });
  const button = await uniqueVisible(buttonCandidates, 20);
  if (button) {
    await button.click({ timeout: 10_000 });
    return;
  }

  throw new Error(
    "Could not identify a unique authenticated Arbetsförmedlingen activity-report navigation control.",
  );
}

export async function waitForActivityReportForm(page: Page): Promise<void> {
  await waitForActivityReportContext(page, 15_000);
  if (await hasMeaningfulFormControls(page)) return;

  const addLink = await uniqueVisible(
    page.getByRole("link", {
      name: /lägg till.*(aktivitet|jobb)|ny aktivitet|sökt.*jobb|registrera.*aktivitet/i,
    }),
    20,
  );
  if (addLink) {
    await addLink.click({ timeout: 10_000 });
  } else {
    const addButton = await uniqueVisible(
      page.getByRole("button", {
        name: /lägg till.*(aktivitet|jobb)|ny aktivitet|sökt.*jobb|registrera.*aktivitet/i,
      }),
      20,
    );
    if (addButton) await addButton.click({ timeout: 10_000 });
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await isArbetsformedlingenAuthenticatedPage(page))) {
      throw new Error(
        "Activity report navigation left the authenticated Arbetsförmedlingen session.",
      );
    }

    if ((await isActivityReportContext(page)) && (await hasMeaningfulFormControls(page))) {
      return;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    "Authenticated Arbetsförmedlingen activity-report form did not become ready before the probe timeout.",
  );
}

async function waitForActivityReportContext(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isArbetsformedlingenAuthenticatedPage(page))) {
      throw new Error(
        "Activity report navigation left the authenticated Arbetsförmedlingen session.",
      );
    }
    if (await isActivityReportContext(page)) return;
    await page.waitForTimeout(400);
  }
  throw new Error("Could not confirm that the authenticated activity-report page loaded.");
}

async function isActivityReportContext(page: Page): Promise<boolean> {
  if (/aktivitetsrapport/i.test(page.url())) return true;
  const text = await safeInnerText(page.locator("main").first());
  return /aktivitetsrapport|rapportera.*aktivitet/i.test(text);
}

async function hasMeaningfulFormControls(page: Page): Promise<boolean> {
  const locator = page.locator("input:not([type='hidden']), select, textarea");
  const count = Math.min(await locator.count(), 100);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) return true;
  }
  return false;
}

export async function uniqueVisible(locator: Locator, limit: number): Promise<Locator | null> {
  const count = Math.min(await locator.count(), limit);
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) visible.push(candidate);
  }
  return visible.length === 1 ? visible[0] : null;
}

async function collectControls(
  page: Page,
  tag: ActivityReportControlProbe["tag"],
  limit: number,
): Promise<ActivityReportControlProbe[]> {
  const locator = page.locator(tag);
  const count = Math.min(await locator.count(), limit);
  const output: ActivityReportControlProbe[] = [];

  for (let index = 0; index < count; index += 1) {
    const control = locator.nth(index);
    if (!(await control.isVisible())) continue;

    const probe: ActivityReportControlProbe = { tag };
    const type = clean(await control.getAttribute("type"));
    const name = clean(await control.getAttribute("name"));
    const id = clean(await control.getAttribute("id"));
    const role = clean(await control.getAttribute("role"));
    const ariaLabel = clean(await control.getAttribute("aria-label"));
    const placeholder = clean(await control.getAttribute("placeholder"));

    if (type) probe.type = type;
    if (name) probe.name = name;
    if (id) probe.id = id;
    if (role) probe.role = role;
    if (ariaLabel) probe.ariaLabel = ariaLabel;
    if (placeholder) probe.placeholder = placeholder;

    if (tag === "button" || tag === "a") {
      const text = clean(await safeInnerText(control));
      if (text) probe.text = text.slice(0, 300);
    }

    if (tag === "a") {
      const href = clean(await control.getAttribute("href"));
      if (href) probe.href = sanitizeLink(href, page.url());
    }

    if (tag === "select") {
      probe.options = (await collectTexts(control.locator("option"), 250)).map((value) =>
        value.slice(0, 200),
      );
    }

    output.push(probe);
  }

  return output;
}

async function collectTexts(locator: Locator, limit: number): Promise<string[]> {
  const count = Math.min(await locator.count(), limit);
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible())) continue;
    const text = clean(await safeInnerText(candidate));
    if (text) output.push(text.slice(0, 500));
  }
  return output;
}

export async function safeInnerText(locator: Locator): Promise<string> {
  try {
    return await locator.innerText();
  } catch {
    return "";
  }
}

function clean(value: string | null): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function sanitizeLink(href: string, base: string): string {
  try {
    const parsed = new URL(href, base);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return parsed.protocol;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid:";
  }
}
