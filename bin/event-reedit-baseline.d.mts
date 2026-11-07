// Types for the read-only baseline runner, so TypeScript tests import it
// without a suppression comment.
export type ActivityRow = {
  subjectType: string;
  subjectId: string;
  description?: string | null;
  event?: string | null;
  properties?: unknown;
  createdAt: Date | string;
};

export type ReeditReport = {
  metric: "event-reedit-within-1h";
  methodVersion: number;
  windowStart: string;
  windowEnd: string;
  observedUntil: string;
  published: number;
  reedited: number;
  underObserved: number;
  sharePercent: number | null;
};

export const REEDIT_WINDOW_MS: number;
export const DEFAULT_WINDOW_DAYS: number;
export const MAX_ROWS: number;
export const METHOD_VERSION: number;
export function classifyActivityRow(row: unknown): "publish" | "edit" | "other";
export function computeReeditShare(
  rows: readonly unknown[],
  window: { windowStart: Date | string; windowEnd: Date | string; observedUntil: Date | string },
): ReeditReport;
export function fetchActivityRows(
  sql: unknown,
  window: { windowStart: Date; fetchEnd: Date },
): Promise<ActivityRow[]>;
export function exceedsRowCap(rowCount: number): boolean;
export function parseArgs(args: readonly string[]): {
  target: "local" | "staging" | "production";
  end: string | null;
  windowDays: number;
  json: boolean;
};
export function failureLine(err: unknown): string;
export function renderReport(report: ReeditReport, json: boolean): string;
