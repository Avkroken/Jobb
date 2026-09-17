import type {
  ApplicationResult,
  AuthenticationState,
  JobCandidate,
  JobProvider,
} from "../../core/src/types";

const DEFAULT_BASE_URL = "https://jobsearch.api.jobtechdev.se";

export interface ArbetsformedlingenJobSearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface JobTechTaxonomyItem {
  concept_id?: string | null;
  label?: string | null;
}

interface JobTechEmployer {
  name?: string | null;
}

interface JobTechWorkplaceAddress {
  municipality?: string | null;
  region?: string | null;
  country?: string | null;
  country_code?: string | null;
  city?: string | null;
}

interface JobTechApplicationDetails {
  url?: string | null;
  reference?: string | null;
}

export interface JobTechSearchHit {
  id?: string | null;
  headline?: string | null;
  webpage_url?: string | null;
  employer?: JobTechEmployer | null;
  workplace_address?: JobTechWorkplaceAddress | null;
  occupation?: JobTechTaxonomyItem | null;
  application_details?: JobTechApplicationDetails | null;
}

interface JobTechSearchResponse {
  hits?: JobTechSearchHit[];
}

export class ArbetsformedlingenJobSearchProvider implements JobProvider {
  readonly id = "arbetsformedlingen" as const;

  private readonly query?: string;
  private readonly limit: number;
  private readonly offset: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArbetsformedlingenJobSearchOptions = {}) {
    this.query = options.query;
    this.limit = clamp(options.limit ?? 25, 1, 100);
    this.offset = Math.max(options.offset ?? 0, 0);
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async authenticate(): Promise<AuthenticationState> {
    return { status: "authenticated" };
  }

  async discover(): Promise<JobCandidate[]> {
    const url = new URL("/search", this.baseUrl);
    if (this.query?.trim()) url.searchParams.set("q", this.query.trim());
    url.searchParams.set("limit", String(this.limit));
    url.searchParams.set("offset", String(this.offset));

    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `JobSearch request failed with ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as JobTechSearchResponse;
    return (payload.hits ?? [])
      .map((hit) => mapJobTechHit(hit, this.baseUrl))
      .filter((job): job is JobCandidate => job !== null);
  }

  async apply(_job: JobCandidate): Promise<ApplicationResult> {
    return {
      status: "failed",
      error:
        "JOBTECH_READ_ONLY: JobSearch exposes job-ad data but does not submit applications.",
    };
  }

  async verify(_job: JobCandidate): Promise<boolean> {
    return false;
  }
}

export function mapJobTechHit(
  hit: JobTechSearchHit,
  baseUrl = DEFAULT_BASE_URL,
): JobCandidate | null {
  const externalId = hit.id?.trim();
  const title = hit.headline?.trim();
  if (!externalId || !title) return null;

  const address = hit.workplace_address ?? undefined;
  const country = address?.country?.trim() || undefined;
  const rawCountryCode = address?.country_code?.trim() || undefined;
  const isSweden = isSwedishLocation(country, rawCountryCode);
  const countryCode = isSweden ? "SE" : rawCountryCode;
  const sourceUrl =
    hit.webpage_url?.trim() || new URL(`/ad/${encodeURIComponent(externalId)}`, baseUrl).toString();

  return {
    provider: "arbetsformedlingen",
    externalId,
    title,
    employer: hit.employer?.name?.trim() || undefined,
    location:
      address?.municipality?.trim() ||
      address?.city?.trim() ||
      address?.region?.trim() ||
      undefined,
    country,
    countryCode,
    isInternational: Boolean(country || rawCountryCode) && !isSweden,
    occupation: hit.occupation?.label?.trim() || undefined,
    occupationConceptId: hit.occupation?.concept_id?.trim() || undefined,
    applicationUrl: hit.application_details?.url?.trim() || undefined,
    applicationReference: hit.application_details?.reference?.trim() || undefined,
    sourceUrl,
  };
}

function isSwedishLocation(
  country?: string,
  countryCode?: string,
): boolean {
  if (countryCode === "199") return true;
  const normalized = country?.toLocaleLowerCase("sv-SE");
  return normalized === "sverige" || normalized === "sweden";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
