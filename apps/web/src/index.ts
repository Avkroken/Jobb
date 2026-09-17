import type { BrowserWorker } from "@cloudflare/playwright";
import { getArbetsformedlingenHandoffStatus } from "./arbetsformedlingen-handoff";
import { requireDashboardAuth, type DashboardAuthEnv } from "./auth";
import {
  type AutomationWorkflowParams,
  JobAutomationWorkflow,
} from "./automation-workflow";
import { getDashboardData, renderDashboard } from "./dashboard";
import type { EmailBinding } from "./notifier";
import { getIntegrationProbe } from "./probe-storage";
import { captureAndPersistActivityReportProbe } from "./probe-service";
import { createArbetsformedlingenProvider } from "./providers";
import type { AutomationEnv } from "./runner";
import {
  getRun,
  scheduledRunId,
  setReportStatus,
  updateRun,
  type AutomationRunRow,
} from "./storage";
import {
  currentMonthKey,
  isApplicationAutomationWindow,
  isScheduledSafetyWindow,
} from "./time";

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
      return Response.json({ status: "ok" });
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
      const now = new Date();
      if (!isApplicationAutomationWindow(now)) {
        return Response.json(
          {
            error:
              "Manuell jobbsökning är endast aktiverad den 1:a–14:e varje månad (Europe/Stockholm).",
          },
          { status: 409 },
        );
      }

      const applicationMonth = currentMonthKey(now);
      const runId = `manual:${applicationMonth}:${crypto.randomUUID()}`;
      const instance = await env.JOB_AUTOMATION.create({
        id: `manual-${crypto.randomUUID()}`,
        params: {
          mode: "manual",
          runId,
          triggeredAt: now.toISOString(),
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
        const existingProbe = await getIntegrationProbe(env.DB, runId);
        if (existingProbe?.status === "captured") {
          await finalizeProbeDiscovery(env, run);
          return Response.json({
            authenticated: true,
            runId,
            probe: {
              probeId: existingProbe.id,
              status: "captured",
              pageUrl: existingProbe.page_url,
              summary: existingProbe.summary_json
                ? JSON.parse(existingProbe.summary_json)
                : null,
            },
            message:
              "BankID och aktivitetsrapportens formulärschema är redan verifierade.",
          });
        }

        if (existingProbe?.status === "capturing") {
          return Response.json({
            authenticated: true,
            runId,
            probe: { probeId: existingProbe.id, status: "capturing" },
            message: "Aktivitetsrapportens formulärschema kartläggs redan.",
          });
        }

        const status = await getArbetsformedlingenHandoffStatus(
          env.BROWSER,
          run.auth_session_id,
        );
        if (!status.authenticated) {
          return Response.json({
            ...status,
            runId,
            message: "BankID-inloggningen är inte verifierad ännu.",
          });
        }

        const probe = await captureAndPersistActivityReportProbe(
          env,
          runId,
          run.auth_session_id,
        );

        if (probe.status === "captured") {
          await finalizeProbeDiscovery(env, run);
        }

        return Response.json({
          ...status,
          runId,
          probe,
          message:
            probe.status === "captured"
              ? "BankID är verifierat och aktivitetsrapportens formulärschema är kartlagt utan fältvärden."
              : probe.status === "capturing"
                ? "BankID är verifierat och formulärproben kör redan."
                : "BankID är verifierat men formulärproben misslyckades och kommer att kunna köras om.",
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

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const triggeredAt = new Date(controller.scheduledTime);
    if (!isScheduledSafetyWindow(triggeredAt)) return;

    const applicationMonth = currentMonthKey(triggeredAt);
    const runId = scheduledRunId(applicationMonth);
    const existing = await getRun(env.DB, runId);
    if (existing && existing.status !== "failed") return;

    const suffix = triggeredAt.toISOString().replace(/[^0-9]/g, "").slice(0, 12);
    await env.JOB_AUTOMATION.create({
      id: `scheduled-${applicationMonth}-${suffix}`,
      params: {
        mode: "scheduled",
        runId,
        triggeredAt: triggeredAt.toISOString(),
      },
    });
  },
} satisfies ExportedHandler<Env>;

async function finalizeProbeDiscovery(
  env: Env,
  run: AutomationRunRow,
): Promise<void> {
  await setReportStatus(env.DB, run.report_month, "ready");
  await updateRun(env.DB, run.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    lastError: null,
    authSessionId: null,
    authLiveViewUrl: null,
    authExpiresAt: null,
  });
}

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
