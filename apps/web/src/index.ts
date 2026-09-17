import type { BrowserWorker } from "@cloudflare/playwright";
import { getArbetsformedlingenHandoffStatus } from "./arbetsformedlingen-handoff";
import { requireDashboardAuth, type DashboardAuthEnv } from "./auth";
import {
  type AutomationWorkflowParams,
  JobAutomationWorkflow,
} from "./automation-workflow";
import { getDashboardData, renderDashboard } from "./dashboard";
import type { EmailBinding } from "./notifier";
import { createArbetsformedlingenProvider } from "./providers";
import type { AutomationEnv } from "./runner";
import { getRun } from "./storage";
import { currentMonthKey } from "./time";

export { JobAutomationWorkflow };

export interface Env extends AutomationEnv, DashboardAuthEnv {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  BROWSER: BrowserWorker;
  EMAIL?: EmailBinding;
  JOB_AUTOMATION: Workflow<AutomationWorkflowParams>;
  STUDENTCONSULTING_EMAIL?: string;
  STUDENTCONSULTING_PASSWORD?: string;
  STUDENTCONSULTING_AUTOSUBMIT?: string;
  JOB_INCLUDE_TERMS?: string;
  JOB_EXCLUDE_TERMS?: string;
  JOB_ALLOWED_LOCATIONS?: string;
  JOB_ALLOWED_COUNTRIES?: string;
  NOTIFY_EMAIL_TO?: string;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_WEBHOOK_URL?: string;
  PUBLIC_BASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        targetApplicationsPerMonth: 10,
        automaticSafetyRun: "14:e, 10:00–20:00 Europe/Stockholm",
        studentConsultingConfigured: Boolean(
          env.STUDENTCONSULTING_EMAIL && env.STUDENTCONSULTING_PASSWORD,
        ),
        studentConsultingAutoSubmit:
          env.STUDENTCONSULTING_AUTOSUBMIT === "true",
        suitabilityConfigured: Boolean(env.JOB_INCLUDE_TERMS?.trim()),
        bankIdNotificationConfigured: Boolean(
          (env.EMAIL && env.NOTIFY_EMAIL_TO && env.NOTIFY_EMAIL_FROM) ||
            env.NOTIFY_WEBHOOK_URL,
        ),
      });
    }

    const authFailure = requireDashboardAuth(request, env);
    if (authFailure) return authFailure;

    if (request.method === "GET" && url.pathname === "/") {
      return renderDashboard();
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      try {
        return Response.json(await getDashboardData(env.DB, env));
      } catch (error) {
        return jsonError(error, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/runs/manual") {
      const applicationMonth = currentMonthKey();
      const runId = `manual:${applicationMonth}:${crypto.randomUUID()}`;
      const instance = await env.JOB_AUTOMATION.create({
        id: `manual-${crypto.randomUUID()}`,
        params: {
          mode: "manual",
          runId,
          triggeredAt: new Date().toISOString(),
        },
      });

      return Response.json(
        { runId, workflowInstanceId: instance.id, status: "queued" },
        { status: 202 },
      );
    }

    const bankIdMatch = url.pathname.match(
      /^\/api\/runs\/([^/]+)\/bankid\/check$/,
    );
    if (request.method === "POST" && bankIdMatch) {
      const runId = decodeURIComponent(bankIdMatch[1]);
      const run = await getRun(env.DB, runId);
      if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
      if (!run.auth_session_id) {
        return Response.json(
          { error: "This run has no active BankID handoff session." },
          { status: 409 },
        );
      }

      try {
        const status = await getArbetsformedlingenHandoffStatus(
          env.BROWSER,
          run.auth_session_id,
        );
        return Response.json({
          ...status,
          runId,
          message: status.authenticated
            ? "BankID-inloggningen är verifierad. Nästa steg är aktivitetsrapportens formuläradapter."
            : "BankID-inloggningen är inte verifierad ännu.",
        });
      } catch (error) {
        return jsonError(error, 502);
      }
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
        return jsonError(error, 502);
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function integerParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonError(error: unknown, status: number): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}
