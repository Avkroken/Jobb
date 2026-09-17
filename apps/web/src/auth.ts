export interface DashboardAuthEnv {
  DASHBOARD_USERNAME?: string;
  DASHBOARD_PASSWORD?: string;
}

export function requireDashboardAuth(
  request: Request,
  env: DashboardAuthEnv,
): Response | null {
  const expectedUser = env.DASHBOARD_USERNAME?.trim();
  const expectedPassword = env.DASHBOARD_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    return new Response("Dashboard authentication is not configured.", {
      status: 503,
    });
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return unauthorized();

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (
      !constantTimeEqual(username, expectedUser) ||
      !constantTimeEqual(password, expectedPassword)
    ) {
      return unauthorized();
    }

    return null;
  } catch {
    return unauthorized();
  }
}

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="jobb"' },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return diff === 0;
}
