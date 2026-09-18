export interface TurnstileEnv {
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
}

interface TurnstileSiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

export async function verifyTurnstile(
  request: Request,
  env: TurnstileEnv,
  token: unknown,
  expectedAction: string,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  const expectedHostnames = new Set(
    (env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );

  if (
    !secret ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    expectedHostnames.size === 0
  ) {
    return false;
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") ?? "",
      }),
    });
    if (!response.ok) return false;

    const result = (await response.json()) as TurnstileSiteverifyResponse;
    return (
      result.success === true &&
      result.action === expectedAction &&
      typeof result.hostname === "string" &&
      expectedHostnames.has(result.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}
