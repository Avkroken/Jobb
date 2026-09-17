export const MONTHLY_APPLICATION_TARGET = 10 as const;

export type JobProviderId = "studentconsulting" | "arbetsformedlingen";

export interface JobCandidate {
  provider: JobProviderId;
  externalId: string;
  title: string;
  employer?: string;
  location?: string;
  countryCode?: string;
  isInternational: boolean;
  sourceUrl: string;
}

export interface ProviderCredentials {
  username: string;
  password: string;
}

export interface CredentialsProvider {
  getStudentConsultingCredentials(): Promise<ProviderCredentials>;
}

export type AuthenticationState =
  | { status: "anonymous" }
  | { status: "authenticated"; expiresAt?: string }
  | { status: "user_action_required"; action: "bankid" | "login"; message?: string }
  | { status: "failed"; code: string; message: string };

export interface JobProvider {
  readonly id: JobProviderId;
  authenticate(): Promise<AuthenticationState>;
  discover(): Promise<JobCandidate[]>;
  apply(job: JobCandidate): Promise<{ status: "submitted" | "failed" | "unknown"; reference?: string; error?: string }>;
  verify(job: JobCandidate): Promise<boolean>;
}

export interface ActivityReportProvider {
  authenticate(): Promise<AuthenticationState>;
  submit(month: string): Promise<{ status: "submitted" | "user_action_required" | "failed"; reference?: string; error?: string }>;
}
