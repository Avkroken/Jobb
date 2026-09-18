import type { BrowserWorker } from "@cloudflare/playwright";
import { getArbetsformedlingenHandoffStatus } from "./arbetsformedlingen-handoff";
import { submitArbetsformedlingenActivityReport } from "./arbetsformedlingen-report";
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
  isActivityReportWindow,
  isApplicationAutomationWindow,
  isScheduledSafetyWindow,
} from "./time";

export { JobAutomationWorkflow };

export interface Env extends AutomationEnv, DashboardAuthEnv, TurnstileEnv {
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
      if (!isActivityReportWindow(new Date())) {
        return Response.json(
          {
            error:
              "Aktivitetsrapporten får bara automatiseras under rapportfönstret 1:a–14:e (Europe/Stockholm).",
          },
          { status: 409 },
        );
      }

      try {
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

        let probe = await getIntegrationProbe(env.DB, runId);
        if (!probe || probe.status === "failed") {
          const captured = await captureAndPersistActivityReportProbe(
            env,
            runId,
            run.auth_session_id,
          );
          if (captured.status !== "captured") {
            return Response.json({
              ...status,
              runId,
              probe: captured,
              message:
                captured.status === "capturing"
                  ? "Aktivitetsrapportens formulärschema kartläggs redan."
                  : "Formulärkartläggningen misslyckades och kan köras om.",
            });
          }
          probe = await getIntegrationProbe(env.DB, runId);
        }

        if (probe?.status === "capturing") {
          return Response.json({
            ...status,
            runId,
            probe: { probeId: probe.id, status: "capturing" },
            message: "Aktivitetsrapportens formulärschema kartläggs redan.",
          });
        }
        if (!probe || probe.status !== "captured") {
          return Response.json({
            ...status,
            runId,
            message:
              "Aktivitetsrapportens formulärschema är ännu inte verifierat.",
          });
        }

        const report = await submitArbetsformedlingenActivityReport(
          env,
          run.auth_session_id,
          run.report_month,
        );
        await applyActivityReportResult(env, run, report);

        return Response.json({
          ...status,
          runId,
          probe: {
            probeId: probe.id,
            status: probe.status,
            pageUrl: probe.page_url,
          },
          report,
          message: activityReportMessage(report),
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

async function applyActivityReportResult(
  env: Env,
  run: AutomationRunRow,
  result: Awaited<ReturnType<typeof submitArbetsformedlingenActivityReport>>,
): Promise<void> {
  if (result.status === "submitted") {
    await updateRun(env.DB, run.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      lastError: null,
      authSessionId: null,
      authLiveViewUrl: null,
      authExpiresAt: null,
    });
    return;
  }

  if (result.status === "needs_user_action") {
    const message = result.issues.join(" | ");
    await setReportStatus(env.DB, run.report_month, "needs_user_auth", message);
    await updateRun(env.DB, run.id, {
      status: "needs_user_auth",
      lastError: message,
    });
    return;
  }

  if (result.status === "unknown") {
    await env.DB
      .prepare(
        "UPDATE reports SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE report_month = ?",
      )
      .bind(result.error, run.report_month)
      .run();
    await updateRun(env.DB, run.id, {
      status: "needs_user_auth",
      lastError: result.error,
    });
    return;
  }

  await setReportStatus(env.DB, run.report_month, "failed", result.error);
  await updateRun(env.DB, run.id, {
    status: "failed",
    completedAt: new Date().toISOString(),
    lastError: result.error,
    authSessionId: null,
    authLiveViewUrl: null,
    authExpiresAt: null,
  });
}

function activityReportMessage(
  result: Awaited<ReturnType<typeof submitArbetsformedlingenActivityReport>>,
): string {
  switch (result.status) {
    case "submitted":
      return "Aktivitetsrapporten är verifierat inskickad.";
    case "needs_user_action":
      return "BankID är verifierat men rapporten behöver användaråtgärd: " +
        result.issues.join(" | ");
    case "unknown":
      return result.error;
    case "failed":
      return result.error;
  }
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
