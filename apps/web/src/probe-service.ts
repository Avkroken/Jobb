import type { BrowserWorker } from "@cloudflare/playwright";
import { captureArbetsformedlingenActivityReportProbe } from "./arbetsformedlingen-probe";
import { recordIntegrationProbe } from "./probe-storage";

export async function captureAndPersistActivityReportProbe(
  env: { DB: D1Database; EVIDENCE: R2Bucket; BROWSER: BrowserWorker },
  runId: string,
  sessionId: string,
) {
  const probeId = crypto.randomUUID();

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
    await recordIntegrationProbe(env.DB, {
      id: probeId,
      runId,
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
    await recordIntegrationProbe(env.DB, {
      id: probeId,
      runId,
      status: "failed",
      error: message,
    });
    return { probeId, status: "failed" as const, error: message };
  }
}
