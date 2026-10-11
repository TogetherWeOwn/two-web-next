export interface WorkflowRun {
  id: number | string;
  event: string;
  pull_requests?: Array<{
    number: number | string;
    head?: { sha?: string };
  }>;
}

export interface SupersessionContext {
  hasCancelledDependency: boolean;
  runId: number;
  pullNumber: number;
  headSha: string;
}

export interface WorkflowRunsContext extends Omit<SupersessionContext, "runId" | "pullNumber"> {
  runId: string;
  pullNumber: string;
  repository: string;
  token: string;
}

export type WorkflowRunsResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<{ workflow_runs?: WorkflowRun[] }>;
};

export type WorkflowRunsFetch = (
  url: URL,
  options: { headers: Record<string, string> },
) => Promise<WorkflowRunsResponse>;

export function isSupersededRun(currentRun: SupersessionContext, runs: WorkflowRun[]): boolean;
export function findSupersedingRun(
  context: WorkflowRunsContext,
  fetchImpl?: WorkflowRunsFetch,
): Promise<boolean>;
