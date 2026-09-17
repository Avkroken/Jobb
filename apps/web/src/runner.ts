import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";
import { startArbetsformedlingenHandoff } from "./arbetsformedlingen-handoff";
import { notifyBankIdRequired, type NotificationEnv } from "./notifier";
import {
  evaluateSuitability,
  suitabilityConfigured,
  type SuitabilityEnv,
} from "./policy";
import { withStudentConsultingProvider, type ProviderEnv } from "./providers";
import {
  addEvidence,
  countVerifiedApplications,
  createApplication,
  createRun,
  ensureReport,
  finishAttempt,
  getRun,
  hasApplicationForJob,
  nextAttemptNumber,
  persistJob,
  recordNotification,
  scheduledRunId,
  setApplicationStatus,
  setReportStatus,
  startAttempt,
  updateRun,
  type RunMode,
} from "./storage";
import {
  currentMonthKey,
  isActivityReportWindow,
  isScheduledSafetyWindow,
  previousMonthKey,
} from "./time";

export interface AutomationEnv
  extends ProviderEnv,
    NotificationEnv,
    SuitabilityEnv {
  DB: D1Database;
  EVIDENCE: R2Bucket;
}

export interface AutomationResult {
  runId: string;
  status: "skipped" | "completed" | "needs_user_auth" | "failed";
  applicationMonth: string;
  reportMonth: string;
  verifiedCount: number;
  message?: string;
}

export async function executeAutomation(
  env: AutomationEnv,
  input: { mode: RunMode; runId?: string; now?: Date },
): Promise<AutomationResult> {
  const now = input.now ?? new Date();
  const applicationMonth = currentMonthKey(now);
  const reportMonth = previousMonthKey(now);

  if (input.mode === "scheduled" && !isScheduledSafetyWindow(now)) {
    return {
      runId: input.runId ?? scheduledRunId(applicationMonth),
      status: "skipped",
      applicationMonth,
      reportMonth,
      verifiedCount: await countVerifiedApplications(env.DB, applicationMonth),
      message: "Outside the 14th 10:00–20:00 Europe/Stockholm safety window.",
    };
  }

  const runId =
    input.runId ??
    (input.mode === "scheduled"
      ? scheduledRunId(applicationMonth)
      : `manual:${applicationMonth}:${crypto.randomUUID()}`);

  const run = await createRun(env.DB, {
    id: runId,
    mode: input.mode,
    applicationMonth,
    reportMonth,
    targetCount: MONTHLY_APPLICATION_TARGET,
  });

  if (run.status === "completed") {
    return {
      runId,
      status: "completed",
      applicationMonth,
      reportMonth,
      verifiedCount: run.verified_count,
    };
  }

  if (
    run.status === "needs_user_auth" &&
    run.auth_expires_at &&
    Date.parse(run.auth_expires_at) > now.getTime()
  ) {
    return {
      runId,
      status: "needs_user_auth",
      applicationMonth,
      reportMonth,
      verifiedCount: run.verified_count,
      message: "A live BankID handoff session is already active.",
    };
  }

  await updateRun(env.DB, runId, {
    status: "running",
    lastError: null,
    authSessionId: null,
    authLiveViewUrl: null,
    authExpiresAt: null,
  });

  await ensureReport(env.DB, reportMonth, MONTHLY_APPLICATION_TARGET);

  let verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
  if (verifiedCount < MONTHLY_APPLICATION_TARGET) {
    const applicationResult = await fillMonthlyApplicationTarget(
      env,
      runId,
      applicationMonth,
      verifiedCount,
    );
    verifiedCount = applicationResult.verifiedCount;

    await updateRun(env.DB, runId, { verifiedCount });

    if (verifiedCount < MONTHLY_APPLICATION_TARGET) {
      const message = applicationResult.error ??
        `Only ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} verified suitable applications are available.`;
      await updateRun(env.DB, runId, {
        status: "failed",
        lastError: message,
        completedAt: new Date().toISOString(),
      });
      return {
        runId,
        status: "failed",
        applicationMonth,
        reportMonth,
        verifiedCount,
        message,
      };
    }
  }

  if (!isActivityReportWindow(now)) {
    await updateRun(env.DB, runId, {
      status: "completed",
      verifiedCount,
      completedAt: new Date().toISOString(),
    });
    return {
      runId,
      status: "completed",
      applicationMonth,
      reportMonth,
      verifiedCount,
      message: "Current-month application target reached. Activity reporting is only opened between the 1st and 14th.",
    };
  }

  const report = await env.DB
    .prepare("SELECT status FROM reports WHERE report_month = ?")
    .bind(reportMonth)
    .first<{ status: string }>();

  if (report?.status === "submitted") {
    await updateRun(env.DB, runId, {
      status: "completed",
      verifiedCount,
      completedAt: new Date().toISOString(),
    });
    return {
      runId,
      status: "completed",
      applicationMonth,
      reportMonth,
      verifiedCount,
      message: "The previous month's activity report is already submitted.",
    };
  }

  const reportableCount = await countVerifiedApplications(env.DB, reportMonth);
  if (reportableCount < MONTHLY_APPLICATION_TARGET) {
    const message =
      `Previous month ${reportMonth} has only ${reportableCount}/${MONTHLY_APPLICATION_TARGET} verified applications. ` +
      "Applications made now cannot legally be backdated into the previous month.";
    await setReportStatus(env.DB, reportMonth, "failed", message);
    await updateRun(env.DB, runId, {
      status: "failed",
      verifiedCount,
      lastError: message,
      completedAt: new Date().toISOString(),
    });
    return {
      runId,
      status: "failed",
      applicationMonth,
      reportMonth,
      verifiedCount,
      message,
    };
  }

  await setReportStatus(env.DB, reportMonth, "ready");

  const handoff = await startArbetsformedlingenHandoff(env.BROWSER);
  await setReportStatus(env.DB, reportMonth, "needs_user_auth");
  await updateRun(env.DB, runId, {
    status: "needs_user_auth",
    verifiedCount,
    authSessionId: handoff.sessionId,
    authLiveViewUrl: handoff.liveViewUrl,
    authExpiresAt: handoff.expiresAt,
    lastNotifiedAt: new Date().toISOString(),
  });

  const notifications = await notifyBankIdRequired(
    env,
    runId,
    handoff.expiresAt,
  );
  for (const notification of notifications) {
    await recordNotification(env.DB, {
      id: crypto.randomUUID(),
      runId,
      kind: "bankid_required",
      channel: notification.channel,
      status: notification.status,
      error: notification.error,
    });
  }

  return {
    runId,
    status: "needs_user_auth",
    applicationMonth,
    reportMonth,
    verifiedCount,
    message: "BankID authentication is required before the activity report can continue.",
  };
}

async function fillMonthlyApplicationTarget(
  env: AutomationEnv,
  runId: string,
  applicationMonth: string,
  startingVerifiedCount: number,
): Promise<{ verifiedCount: number; error?: string }> {
  if (!suitabilityConfigured(env)) {
    return {
      verifiedCount: startingVerifiedCount,
      error: "Suitability policy is not configured. Set JOB_INCLUDE_TERMS before enabling autonomous applications.",
    };
  }

  if (env.STUDENTCONSULTING_AUTOSUBMIT !== "true") {
    return {
      verifiedCount: startingVerifiedCount,
      error: "StudentConsulting autosubmit is disabled. Set STUDENTCONSULTING_AUTOSUBMIT=true after validating account configuration.",
    };
  }

  return withStudentConsultingProvider(env, async (provider) => {
    const auth = await provider.authenticate();
    if (auth.status !== "authenticated") {
      return {
        verifiedCount: startingVerifiedCount,
        error:
          auth.status === "failed"
            ? `${auth.code}: ${auth.message}`
            : "StudentConsulting authentication did not complete.",
      };
    }

    const discovered = await provider.discover();
    const suitable = discovered.filter(
      (job) => evaluateSuitability(env, job).suitable,
    );
    let verifiedCount = startingVerifiedCount;

    for (const job of suitable) {
      if (verifiedCount >= MONTHLY_APPLICATION_TARGET) break;
      if (await hasApplicationForJob(env.DB, job.provider, job.externalId)) {
        continue;
      }

      const jobId = await persistJob(env.DB, job);
      const applicationId = `application:${job.provider}:${job.externalId}`;
      await createApplication(env.DB, {
        id: applicationId,
        jobId,
        runId,
        reportMonth: applicationMonth,
      });
      await setApplicationStatus(env.DB, applicationId, "applying");

      const attemptNo = await nextAttemptNumber(env.DB, applicationId);
      const attemptId = await startAttempt(env.DB, applicationId, attemptNo);

      try {
        const result = await provider.apply(job);
        const appliedAt = new Date().toISOString();

        if (result.status !== "submitted") {
          await finishAttempt(
            env.DB,
            attemptId,
            result.status === "failed" ? "failed" : "unknown",
            result.status === "failed" ? "APPLICATION_FAILED" : "APPLICATION_UNKNOWN",
            result.error,
          );
          await setApplicationStatus(
            env.DB,
            applicationId,
            result.status === "failed" ? "failed" : "needs_user_action",
          );
          continue;
        }

        await setApplicationStatus(env.DB, applicationId, "submitted", {
          appliedAt,
        });

        const verified = await provider.verify(job);
        if (!verified) {
          await finishAttempt(
            env.DB,
            attemptId,
            "unknown",
            "VERIFICATION_FAILED",
            "StudentConsulting did not show the exact Jobb-ID in Ansökningar.",
          );
          await setApplicationStatus(env.DB, applicationId, "needs_user_action", {
            appliedAt,
          });
          continue;
        }

        const verifiedAt = new Date().toISOString();
        await finishAttempt(env.DB, attemptId, "verified");
        await setApplicationStatus(env.DB, applicationId, "verified", {
          appliedAt,
          verifiedAt,
        });

        const objectKey = `applications/${applicationMonth}/${job.externalId}.json`;
        await env.EVIDENCE.put(
          objectKey,
          JSON.stringify({
            job,
            appliedAt,
            verifiedAt,
            verification: "StudentConsulting Ansökningar exact Jobb-ID match",
          }),
          { httpMetadata: { contentType: "application/json" } },
        );
        await addEvidence(env.DB, {
          id: `evidence:${applicationId}`,
          applicationId,
          kind: "studentconsulting-verification",
          objectKey,
        });

        verifiedCount += 1;
        await updateRun(env.DB, runId, { verifiedCount });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishAttempt(
          env.DB,
          attemptId,
          "failed",
          "UNEXPECTED_APPLICATION_ERROR",
          message,
        );
        await setApplicationStatus(env.DB, applicationId, "failed");
      }
    }

    return {
      verifiedCount,
      error:
        verifiedCount < MONTHLY_APPLICATION_TARGET
          ? `Only ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} suitable verified applications could be completed from the current StudentConsulting listings.`
          : undefined,
    };
  });
}

export async function getCurrentScheduledRun(
  env: AutomationEnv,
  now = new Date(),
) {
  return getRun(env.DB, scheduledRunId(currentMonthKey(now)));
}
