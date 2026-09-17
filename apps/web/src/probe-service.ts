import type { BrowserWorker } from "@cloudflare/playwright";
import { captureArbetsformedlingenActivityReportProbe } from "./arbetsformedlingen-probe";
import {
  completeIntegrationProbe,
  reserveIntegrationProbe,
} from "./probe-storage";

export async function captureAndPersistActivityReportProbe(
  env: { DB: D1Database; EVIDENCE: R2Bucket; BROWSER: BrowserWorker },
  runId: string,
  sessionId: string,
) {
  const reservation = await reserveIntegrationProbe(env.DB, runId);
  const probeId = reservation.probe.id;

  if (!reservation.acquired) {
    if (reservation.probe.status === "captured") {
      return {
        probeId,
        status: "captured" as const,
        pageUrl: reservation.probe.page_url,
        summary: reservation.probe.summary_json
          ? JSON.parse(reservation.probe.summary_json)
          : null,
      };
    }

    return {
      probeId,
      status: "capturing" as const,
      message: "Another request is already capturing the activity-report schema.",
    };
  }

  try {
    const probe = await captureArbetsformedlingenActivityReportProbe(
      env.BROWSER,
      sessionId,
    );
    const objectKey = `probes/arbetsformedlingen/${runId}/${probeId}.json`;
    const summary = {
      headings: probe.headings,
      controlCount: probe.controls.length,
      mandatoryQuestionCandidates: probe.mandatoryQuestionCandidates,
    };

    await env.EVIDENCE.put(objectKey, JSON.stringify(probe, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    await completeIntegrationProbe(env.DB, {
      id: probeId,
      status: "captured",
      pageUrl: probe.pageUrl,
      objectKey,
      summary,
    });

    return {
      probeId,
      status: "captured" as const,
      pageUrl: probe.pageUrl,
      summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeIntegrationProbe(env.DB, {
      id: probeId,
      status: "failed",
      error: message,
    });
    return { probeId, status: "failed" as const, error: message };
  }
}
