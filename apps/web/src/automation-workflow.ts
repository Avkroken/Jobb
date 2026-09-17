import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { executeAutomation, type AutomationEnv } from "./runner";

export interface AutomationWorkflowParams {
  mode?: "manual" | "scheduled";
  runId?: string;
  triggeredAt?: string;
}

export class JobAutomationWorkflow extends WorkflowEntrypoint<
  AutomationEnv,
  AutomationWorkflowParams
> {
  async run(
    event: WorkflowEvent<AutomationWorkflowParams>,
    step: WorkflowStep,
  ) {
    const trigger = await step.do("resolve trigger", async () => ({
      mode: event.payload?.mode ?? "scheduled",
      runId: event.payload?.runId,
      triggeredAt: event.payload?.triggeredAt ?? event.timestamp.toISOString(),
    }));

    return step.do(
      "execute application automation",
      {
        retries: { limit: 0, delay: "1 second" },
        timeout: "30 minutes",
      },
      async () =>
        executeAutomation(this.env, {
          mode: trigger.mode,
          runId: trigger.runId,
          now: new Date(trigger.triggeredAt),
        }),
    );
  }
}
