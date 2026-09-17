import type { JobCandidate } from "../../../packages/core/src/types";

export interface SuitabilityEnv {
  JOB_INCLUDE_TERMS?: string;
  JOB_EXCLUDE_TERMS?: string;
  JOB_ALLOWED_LOCATIONS?: string;
  JOB_ALLOWED_COUNTRIES?: string;
}

export interface SuitabilityDecision {
  suitable: boolean;
  reasons: string[];
}

export function suitabilityConfigured(env: SuitabilityEnv): boolean {
  return csv(env.JOB_INCLUDE_TERMS).length > 0;
}

export function evaluateSuitability(
  env: SuitabilityEnv,
  job: JobCandidate,
): SuitabilityDecision {
  const include = csv(env.JOB_INCLUDE_TERMS).map(normalize);
  const exclude = csv(env.JOB_EXCLUDE_TERMS).map(normalize);
  const locations = csv(env.JOB_ALLOWED_LOCATIONS).map(normalize);
  const countries = csv(env.JOB_ALLOWED_COUNTRIES || "SE").map((value) =>
    value.toUpperCase(),
  );

  const haystack = normalize(
    [job.title, job.occupation, job.location, job.employer]
      .filter(Boolean)
      .join(" "),
  );
  const reasons: string[] = [];

  if (include.length === 0) {
    reasons.push("JOB_INCLUDE_TERMS is not configured");
  } else if (!include.some((term) => haystack.includes(term))) {
    reasons.push("no configured include term matched");
  }

  const blocked = exclude.find((term) => haystack.includes(term));
  if (blocked) reasons.push(`excluded term matched: ${blocked}`);

  if (
    locations.length > 0 &&
    !locations.some((location) => normalize(job.location ?? "").includes(location))
  ) {
    reasons.push("location is outside configured allowed locations");
  }

  if (
    countries.length > 0 &&
    job.countryCode &&
    !countries.includes(job.countryCode.toUpperCase())
  ) {
    reasons.push("country is outside configured allowed countries");
  }

  return { suitable: reasons.length === 0, reasons };
}

function csv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}
