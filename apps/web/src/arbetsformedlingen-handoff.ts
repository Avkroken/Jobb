import {
  acquire,
  connect,
  type BrowserWorker,
  type Page,
} from "@cloudflare/playwright";
import { isHostOrSubdomain } from "../../../packages/core/src/url";

const MINA_SIDOR_URL =
  "https://arbetsformedlingen.se/for-arbetssokande/mina-sidor";
const ARBETSFOMEDLINGEN_DOMAIN = "arbetsformedlingen.se";
const LIVE_VIEW_TTL_MS = 10 * 60 * 1_000;

export interface ArbetsformedlingenHandoff {
  sessionId: string;
  liveViewUrl: string;
  expiresAt: string;
}

export interface ArbetsformedlingenHandoffStatus {
  authenticated: boolean;
  currentUrl: string;
}

export async function startArbetsformedlingenHandoff(
  binding: BrowserWorker,
): Promise<ArbetsformedlingenHandoff> {
  const { sessionId } = await acquire(binding, {
    keep_alive: LIVE_VIEW_TTL_MS,
  });
  const browser = await connect(binding, sessionId);

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(MINA_SIDOR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const login = page.getByRole("link", { name: "Logga in", exact: true }).first();
    if ((await login.count()) === 0) {
      throw new Error("Arbetsförmedlingen login link was not found.");
    }

    await login.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });

    const liveViewUrl = await getLiveViewUrl(page, LIVE_VIEW_TTL_MS);
    return {
      sessionId,
      liveViewUrl,
      expiresAt: new Date(Date.now() + LIVE_VIEW_TTL_MS).toISOString(),
    };
  } finally {
    await browser.close();
  }
}

export async function getArbetsformedlingenHandoffStatus(
  binding: BrowserWorker,
  sessionId: string,
): Promise<ArbetsformedlingenHandoffStatus> {
  const browser = await connect(binding, sessionId);

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      authenticated: await isArbetsformedlingenAuthenticatedPage(page),
      currentUrl: sanitizeArbetsformedlingenBrowserUrl(page.url()),
    };
  } finally {
    await browser.close();
  }
}

export async function refreshArbetsformedlingenLiveView(
  binding: BrowserWorker,
  sessionId: string,
): Promise<{ liveViewUrl: string; expiresAt: string }> {
  const browser = await connect(binding, sessionId);

  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      liveViewUrl: await getLiveViewUrl(page, LIVE_VIEW_TTL_MS),
      expiresAt: new Date(Date.now() + LIVE_VIEW_TTL_MS).toISOString(),
    };
  } finally {
    await browser.close();
  }
}

export async function isArbetsformedlingenAuthenticatedPage(
  page: Page,
): Promise<boolean> {
  let current: URL;
  try {
    current = new URL(page.url());
  } catch {
    return false;
  }

  if (
    current.protocol !== "https:" ||
    !isHostOrSubdomain(current.hostname, ARBETSFOMEDLINGEN_DOMAIN)
  ) {
    return false;
  }

  const logout = page.getByText(/logga ut/i).first();
  return (await logout.count()) > 0 && (await logout.isVisible());
}

export function sanitizeArbetsformedlingenBrowserUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return parsed.protocol;
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid:";
  }
}

async function getLiveViewUrl(page: Page, expiresInMs: number): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const cloudflareCdp = cdp as unknown as {
    send(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<{ devtoolsFrontendUrl?: string }>;
  };
  const result = await cloudflareCdp.send("Cloudflare.getLiveView", {
    mode: "tab",
    expiresInMs,
  });

  if (!result.devtoolsFrontendUrl) {
    throw new Error("Cloudflare Browser Run did not return a Live View URL.");
  }

  return result.devtoolsFrontendUrl;
}
