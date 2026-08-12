import { Render } from "@renderinc/sdk";

/**
 * Kick the campusBriefing task on the Render Workflows service.
 * Returns null when RENDER_API_KEY / RENDER_WORKFLOW_SLUG aren't set
 * (local dev — the caller falls back to inline generation).
 */
export async function triggerBriefingWorkflow(): Promise<{
  runId: string;
  task: string;
} | null> {
  const apiKey = process.env.RENDER_API_KEY;
  const slug = process.env.RENDER_WORKFLOW_SLUG;
  if (!apiKey || !slug) return null;

  const render = new Render({ token: apiKey });
  const taskId = `${slug}/campusBriefing`;
  const run = await render.workflows.startTask(taskId, ["Georgia Tech"]);
  return { runId: run.taskRunId, task: taskId };
}
