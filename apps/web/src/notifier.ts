export interface EmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

export interface NotificationEnv {
  EMAIL?: EmailBinding;
  NOTIFY_EMAIL_TO?: string;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_WEBHOOK_URL?: string;
  PUBLIC_BASE_URL?: string;
}

export interface NotificationResult {
  channel: "email" | "webhook";
  status: "sent" | "failed";
  error?: string;
}

export async function notifyBankIdRequired(
  env: NotificationEnv,
  runId: string,
  expiresAt: string,
): Promise<NotificationResult[]> {
  const dashboardUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  const results: NotificationResult[] = [];

  if (env.EMAIL && env.NOTIFY_EMAIL_TO && env.NOTIFY_EMAIL_FROM) {
    try {
      await env.EMAIL.send({
        to: env.NOTIFY_EMAIL_TO,
        from: env.NOTIFY_EMAIL_FROM,
        subject: "Jobb: BankID krävs för aktivitetsrapporten",
        text: [
          "Jobbautomation väntar på din BankID-signering.",
          dashboardUrl ? `Öppna dashboarden: ${dashboardUrl}` : "Öppna jobb-dashboarden.",
          `Sessionen gäller till ${expiresAt}.`,
          `Körning: ${runId}`,
        ].join("\n"),
      });
      results.push({ channel: "email", status: "sent" });
    } catch (error) {
      results.push({
        channel: "email",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (env.NOTIFY_WEBHOOK_URL) {
    try {
      const response = await fetch(env.NOTIFY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "bankid_required",
          runId,
          expiresAt,
          dashboardUrl: dashboardUrl || undefined,
          message: "Jobbautomation väntar på BankID-signering.",
        }),
      });
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
      results.push({ channel: "webhook", status: "sent" });
    } catch (error) {
      results.push({
        channel: "webhook",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
