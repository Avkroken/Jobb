import type { BrowserWorker } from "@cloudflare/playwright";
import { createArbetsformedlingenProvider } from "./providers";

export interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  BROWSER: BrowserWorker;
  STUDENTCONSULTING_EMAIL?: string;
  STUDENTCONSULTING_PASSWORD?: string;
  STUDENTCONSULTING_AUTOSUBMIT?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        targetApplicationsPerMonth: 10,
        studentConsultingConfigured: Boolean(
          env.STUDENTCONSULTING_EMAIL && env.STUDENTCONSULTING_PASSWORD,
        ),
        studentConsultingAutoSubmit:
          env.STUDENTCONSULTING_AUTOSUBMIT === "true",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/jobs/search") {
      const provider = createArbetsformedlingenProvider({
        query: url.searchParams.get("q") ?? undefined,
        limit: integerParam(url.searchParams.get("limit"), 25),
        offset: integerParam(url.searchParams.get("offset"), 0),
      });

      try {
        const jobs = await provider.discover();
        return Response.json({ jobs });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 },
        );
      }
    }

    return new Response("jobb — job application automation", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;

function integerParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
