import type { CredentialsProvider, ProviderCredentials } from "../../core/src/types";

export interface StudentConsultingSecretEnv {
  STUDENTCONSULTING_EMAIL?: string;
  STUDENTCONSULTING_PASSWORD?: string;
}

export class EnvironmentCredentialsProvider implements CredentialsProvider {
  constructor(private readonly env: StudentConsultingSecretEnv) {}

  async getStudentConsultingCredentials(): Promise<ProviderCredentials> {
    const username = this.env.STUDENTCONSULTING_EMAIL?.trim();
    const password = this.env.STUDENTCONSULTING_PASSWORD;

    if (!username || !password) {
      throw new Error("StudentConsulting credentials are not configured");
    }

    return { username, password };
  }
}
