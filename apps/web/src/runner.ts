import {
  MONTHLY_APPLICATION_TARGET,
  type JobCandidate,
  type JobProvider,
} from "../../../packages/core/src/types";
import { startArbetsformedlingenHandoff } from "./arbetsformedlingen-handoff";
import { notifyBankIdRequired, type NotificationEnv } from "./notifier";
import {
  evaluateSuitability,
  suitabilityConfigured,
  type SuitabilityEnv,
} from "./policy";
import { withStudentConsultingProvider, type ProviderEnv } from "./providers";
import {
  claimMonthlyApplicationSlot,
  countOccupiedMonthlyApplicationSlots,
  reconcileMonthlyApplicationSlotState,
  releaseMonthlyApplicationSlot,
  setOwnedMonthlyApplicationSlotState,
} from "./quota";
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
  isApplicationAutomationWindow,
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
  const clock = () => input.now ?? new Date();
  const now = clock();
  const applicationMonth = currentMonthKey(now);
  const reportMonth = previousMonthKey(now);

  if (!isApplicationAutomationWindow(now)) {
    return {
      runId:
        input.runId ??
        (input.mode === "scheduled"
          ? scheduledRunId(applicationMonth)
          : `manual:${applicationMonth}:${crypto.randomUUID()}`),
      status: "skipped",
      applicationMonth,
      reportMonth,
      verifiedCount: await countVerifiedApplications(env.DB, applicationMonth),
      message:
        "Job application automation is disabled outside the 1st–14th Europe/Stockholm monthly window.",
    };
  }

  if (input.mode === "scheduled" && !isScheduledSafetyWindow(now)) {
    return {
      runId: input.runId ?? scheduledRunId(applicationMonth),
      status: "skipped",
      applicationMonth,
      reportMonth,
      verifiedCount: await countVerifiedApplications(env.DB, applicationMonth),
      message:
        "Outside the autonomous fallback window: 10th–13th, 10:00–20:00 Europe/Stockholm.",
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
      () => {
        const executionTime = clock();
        return (
          isApplicationAutomationWindow(executionTime) &&
          (input.mode !== "scheduled" || isScheduledSafetyWindow(executionTime))
        );
      },
    );
    verifiedCount = applicationResult.verifiedCount;

    await updateRun(env.DB, runId, { verifiedCount });

    if (verifiedCount < MONTHLY_APPLICATION_TARGET) {
      const occupiedSlots = await countOccupiedMonthlyApplicationSlots(
        env.DB,
        applicationMonth,
      );
      const message =
        applicationResult.error ??
        `Only ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} verified applications are available; ${occupiedSlots}/${MONTHLY_APPLICATION_TARGET} quota slots are occupied.`;
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

  const reportNow = clock();
  if (!isActivityReportWindow(reportNow)) {
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
      message:
        "Current-month application target reached. Activity reporting is only opened between the 1st and 14th.",
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
      "Applications made now cannot be backdated into the previous month.";
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

  const notifications = await notifyBankIdRequired(env, runId, handoff.expiresAt);
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
    message:
      "BankID authentication is required before the activity report can continue.",
  };
}

async function fillMonthlyApplicationTarget(
  env: AutomationEnv,
  runId: string,
  applicationMonth: string,
  startingVerifiedCount: number,
  canSubmitNow: () => boolean,
): Promise<{ verifiedCount: number; error?: string }> {
  if (!suitabilityConfigured(env)) {
    return {
      verifiedCount: startingVerifiedCount,
      error:
        "Suitability policy is not configured. Set JOB_INCLUDE_TERMS before enabling autonomous applications.",
    };
  }

  if (env.STUDENTCONSULTING_AUTOSUBMIT !== "true") {
    return {
      verifiedCount: startingVerifiedCount,
      error:
        "StudentConsulting autosubmit is disabled. Set STUDENTCONSULTING_AUTOSUBMIT=true after validating account configuration.",
    };
  }

  if (!canSubmitNow()) {
    return {
      verifiedCount: startingVerifiedCount,
      error:
        "Application window closed before automation execution; no StudentConsulting submission was attempted.",
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

    let verifiedCount = await reconcilePendingApplications(
      env,
      provider,
      applicationMonth,
      runId,
    );
    if (verifiedCount >= MONTHLY_APPLICATION_TARGET) {
      return { verifiedCount };
    }

    const occupiedBefore = await countOccupiedMonthlyApplicationSlots(
      env.DB,
      applicationMonth,
    );
    if (occupiedBefore >= MONTHLY_APPLICATION_TARGET) {
      return {
        verifiedCount,
        error:
          `All ${MONTHLY_APPLICATION_TARGET} monthly application slots are occupied, but only ${verifiedCount} are verified. ` +
          "Submitted/uncertain applications were rechecked and remain unresolved; no additional application will be sent.",
      };
    }

    const discovered = await provider.discover();
    const suitable = discovered.filter(
      (job) => evaluateSuitability(env, job).suitable,
    );

    for (const job of suitable) {
      verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
      if (verifiedCount >= MONTHLY_APPLICATION_TARGET) break;

      if (!canSubmitNow()) {
        return {
          verifiedCount,
          error:
            "Application window closed before the next submission; automation stopped without sending another application.",
        };
      }

      if (
        (await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth)) >=
        MONTHLY_APPLICATION_TARGET
      ) {
        break;
      }

      if (await hasApplicationForJob(env.DB, job.provider, job.externalId)) {
        continue;
      }

      const applicationId = `application:${job.provider}:${job.externalId}`;
      const reservationOwner = `${runId}:${crypto.randomUUID()}`;
      const quotaClaim = await claimMonthlyApplicationSlot(
        env.DB,
        applicationMonth,
        applicationId,
        reservationOwner,
      );
      if (!quotaClaim) {
        if (
          (await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth)) >=
          MONTHLY_APPLICATION_TARGET
        ) {
          break;
        }
        continue;
      }

      let attemptId: string | undefined;
      let submissionAttempted = false;
      let verificationCommitted = false;

      try {
        const jobId = await persistJob(env.DB, job);
        await createApplication(env.DB, {
          id: applicationId,
          jobId,
          runId,
          reportMonth: applicationMonth,
        });

        const claim = await env.DB
          .prepare(
            `SELECT automation_run_id, status
             FROM applications WHERE id = ?`,
          )
          .bind(applicationId)
          .first<{ automation_run_id: string | null; status: string }>();
        if (
          !claim ||
          claim.automation_run_id !== runId ||
          claim.status !== "queued"
        ) {
          await releaseMonthlyApplicationSlot(
            env.DB,
            applicationId,
            reservationOwner,
          );
          continue;
        }

        await setApplicationStatus(env.DB, applicationId, "applying");

        const attemptNo = await nextAttemptNumber(env.DB, applicationId);
        attemptId = await startAttempt(env.DB, applicationId, attemptNo);

        if (!canSubmitNow()) {
          await finishAttempt(
            env.DB,
            attemptId,
            "failed",
            "APPLICATION_WINDOW_CLOSED",
            "Application window closed before the external submit control was activated.",
          );
          await setApplicationStatus(env.DB, applicationId, "failed");
          await releaseMonthlyApplicationSlot(
            env.DB,
            applicationId,
            reservationOwner,
          );
          continue;
        }

        const result = await provider.apply(job);
        submissionAttempted =
          result.submissionAttempted === true || result.status === "submitted";
        const appliedAt = submissionAttempted
          ? new Date().toISOString()
          : undefined;

        if (result.status !== "submitted") {
          await finishAttempt(
            env.DB,
            attemptId,
            result.status === "failed" && !submissionAttempted
              ? "failed"
              : "unknown",
            result.status === "failed" && !submissionAttempted
              ? "APPLICATION_FAILED"
              : "APPLICATION_UNKNOWN",
            result.error,
          );

          if (result.status === "failed" && !submissionAttempted) {
            await setApplicationStatus(env.DB, applicationId, "failed");
            await releaseMonthlyApplicationSlot(
              env.DB,
              applicationId,
              reservationOwner,
            );
          } else {
            await setOwnedMonthlyApplicationSlotState(
              env.DB,
              applicationId,
              reservationOwner,
              "uncertain",
            );
            await setApplicationStatus(
              env.DB,
              applicationId,
              "needs_user_action",
              appliedAt ? { appliedAt } : {},
            );
          }
          continue;
        }

        await setOwnedMonthlyApplicationSlotState(
          env.DB,
          applicationId,
          reservationOwner,
          "submitted",
        );
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
          await setApplicationStatus(
            env.DB,
            applicationId,
            "needs_user_action",
            appliedAt ? { appliedAt } : {},
          );
          continue;
        }

        const verifiedAt = new Date().toISOString();
        await finishAttempt(env.DB, attemptId, "verified");
        await setOwnedMonthlyApplicationSlotState(
          env.DB,
          applicationId,
          reservationOwner,
          "verified",
        );
        await setApplicationStatus(env.DB, applicationId, "verified", {
          appliedAt,
          verifiedAt,
        });
        verificationCommitted = true;

        verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
        await updateRun(env.DB, runId, { verifiedCount });

        await persistVerificationEvidence(
          env,
          runId,
          applicationId,
          applicationMonth,
          job,
          appliedAt ?? verifiedAt,
          verifiedAt,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (verificationCommitted) {
          await recordApplicationDiagnostic(
            env.DB,
            applicationId,
            "POST_VERIFICATION_ERROR",
            message,
          );
          continue;
        }

        if (attemptId) {
          await finishAttempt(
            env.DB,
            attemptId,
            submissionAttempted ? "unknown" : "failed",
            "UNEXPECTED_APPLICATION_ERROR",
            message,
          );
        }

        if (submissionAttempted) {
          await setOwnedMonthlyApplicationSlotState(
            env.DB,
            applicationId,
            reservationOwner,
            "uncertain",
          );
          await setApplicationStatus(env.DB, applicationId, "needs_user_action");
        } else {
          await setApplicationStatus(env.DB, applicationId, "failed");
          await releaseMonthlyApplicationSlot(
            env.DB,
            applicationId,
            reservationOwner,
          );
        }
      }
    }

    verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
    const occupied = await countOccupiedMonthlyApplicationSlots(
      env.DB,
      applicationMonth,
    );
    return {
      verifiedCount,
      error:
        verifiedCount < MONTHLY_APPLICATION_TARGET
          ? occupied >= MONTHLY_APPLICATION_TARGET
            ? `${occupied}/${MONTHLY_APPLICATION_TARGET} monthly slots are occupied, but only ${verifiedCount} are verified. Existing uncertain submissions will be rechecked; no additional applications will be sent meanwhile.`
            : `Only ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} suitable verified applications could be completed from the current StudentConsulting listings.`
          : undefined,
    };
  });
}

async function reconcilePendingApplications(
  env: AutomationEnv,
  provider: JobProvider,
  applicationMonth: string,
  runId: string,
): Promise<number> {
  const pending = await env.DB
    .prepare(
      `SELECT a.id, a.applied_at, j.raw_json
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       JOIN monthly_application_slots s ON s.application_id = a.id
       WHERE a.report_month = ?
         AND a.status IN ('applying','submitted','needs_user_action')
         AND s.state IN ('submitted','uncertain')
       ORDER BY COALESCE(a.applied_at, a.created_at), a.id`,
    )
    .bind(applicationMonth)
    .all<{ id: string; applied_at: string | null; raw_json: string | null }>();

  for (const row of pending.results) {
    let job: JobCandidate;
    try {
      job = JSON.parse(row.raw_json ?? "") as JobCandidate;
    } catch {
      await recordApplicationDiagnostic(
        env.DB,
        row.id,
        "RECONCILIATION_DATA_INVALID",
        "Stored job payload could not be parsed for verification.",
      );
      continue;
    }

    if (job.provider !== "studentconsulting") continue;

    const verified = await provider.verify(job);
    if (!verified) continue;

    const verifiedAt = new Date().toISOString();
    const attemptNo = await nextAttemptNumber(env.DB, row.id);
    const attemptId = await startAttempt(env.DB, row.id, attemptNo);
    await finishAttempt(env.DB, attemptId, "verified");
    await reconcileMonthlyApplicationSlotState(env.DB, row.id, "verified");
    await setApplicationStatus(env.DB, row.id, "verified", { verifiedAt });

    await persistVerificationEvidence(
      env,
      runId,
      row.id,
      applicationMonth,
      job,
      row.applied_at ?? verifiedAt,
      verifiedAt,
    );
  }

  return countVerifiedApplications(env.DB, applicationMonth);
}

async function persistVerificationEvidence(
  env: AutomationEnv,
  runId: string,
  applicationId: string,
  applicationMonth: string,
  job: JobCandidate,
  appliedAt: string,
  verifiedAt: string,
): Promise<void> {
  try {
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
  } catch (error) {
    await recordApplicationDiagnostic(
      env.DB,
      applicationId,
      "EVIDENCE_WRITE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
    await updateRun(env.DB, runId, {
      lastError:
        "An application was verified, but its evidence object could not be persisted. Verification remains valid.",
    });
  }
}

async function recordApplicationDiagnostic(
  db: D1Database,
  applicationId: string,
  code: string,
  message: string,
): Promise<void> {
  const attemptNo = await nextAttemptNumber(db, applicationId);
  const attemptId = await startAttempt(db, applicationId, attemptNo);
  await finishAttempt(db, attemptId, "failed", code, message);
}

export async function getCurrentScheduledRun(
  env: AutomationEnv,
  now = new Date(),
) {
  return getRun(env.DB, scheduledRunId(currentMonthKey(now)));
}
