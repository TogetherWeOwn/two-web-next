import type postgres from "postgres";

export interface TableReport {
  table: string;
  dry_run: boolean;
  cutoff: string;
  total: number;
  eligible: number;
  skipped_old: number;
  skipped_missing_timestamp: number;
  would_insert: number;
  would_update: number;
  unchanged: number;
  inserted: number;
  updated: number;
}

export function importContentFunnel(options: {
  legacy: postgres.Sql;
  target: postgres.Sql;
  legacySchema?: string;
  targetSchema?: string;
  dryRun?: boolean;
  now?: Date;
}): Promise<TableReport[]>;

export function parseArgs(args: string[]): { help: boolean; dryRun: boolean };
export function connectionSettings(env: NodeJS.ProcessEnv, dryRun: boolean): {
  legacyUrl: string;
  targetUrl: string;
  legacySchema: string;
  targetSchema: string;
  legacyOptions: postgres.Options<{}>;
  targetOptions: postgres.Options<{}>;
};
