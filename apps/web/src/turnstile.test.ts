import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "./turnstile";

afterEach(() => vi.restoreAllMocks());

describe("verifyTurnstile", () => {
  const request = new Request("https://jobb.denied.se/api/runs/manual", {
    headers: { "CF-Connecting-IP": "192.0.2.1" },
  });
  const env = {
    TURNSTILE_SECRET: "test-secret",
    TURNSTILE_HOSTNAMES: "jobb.denied.se",
  };

  it("accepts a successful response for the expected action and hostname", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ success: true, action: "manual_run", hostname: "jobb.denied.se" }),
    ));
    await expect(verifyTurnstile(request, env, "token", "manual_run")).resolves.toBe(true);
  });

  it.each([
    { success: false, action: "manual_run", hostname: "jobb.denied.se" },
    { success: true, action: "other", hostname: "jobb.denied.se" },
    { success: true, action: "manual_run", hostname: "evil.example" },
  ])("rejects invalid verification results", async (result) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)));
    await expect(verifyTurnstile(request, env, "token", "manual_run")).resolves.toBe(false);
  });

  it("fails closed when configuration or token is missing", async () => {
    await expect(verifyTurnstile(request, {}, "token", "manual_run")).resolves.toBe(false);
    await expect(verifyTurnstile(request, env, "", "manual_run")).resolves.toBe(false);
  });
});
