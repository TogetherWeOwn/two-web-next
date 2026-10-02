import type { Sql } from "postgres";

export interface FieldMapping {
  name: string;
  legacy: string;
  next: string;
}
export interface TableMapping {
  name: string;
  legacy: { from: string; where?: string };
  next: { from: string; where?: string };
  keys: FieldMapping[];
  columns: FieldMapping[];
  mappingGaps?: string[];
}
export interface TableReport {
  table: string;
  keyColumns: string[];
  comparedColumns: string[];
  legacyCount: number;
  nextCount: number;
  missingCount: number;
  extraCount: number;
  mismatchCount: number;
  missingKeys: string[][];
  extraKeys: string[][];
  mismatchKeys: string[][];
  mappingGaps: string[];
  detailsTruncated: boolean;
}
export interface VerificationReport {
  version: number;
  ok: boolean;
  batchSize: number;
  detailLimit: number;
  tables: TableReport[];
}
export class VerificationError extends Error {
  code: string;
  constructor(code: string);
}
export function quoteIdentifier(value: string): string;
export function validateMap(map: unknown): TableMapping[];
export function compareKeys(a: string[], b: string[]): number;
export function assertDistinctDatabases(legacyRaw: string, nextRaw: string): void;
export function verify(options: {
  legacy: Sql;
  next: Sql;
  map: TableMapping[];
  batchSize?: number;
  detailLimit?: number;
}): Promise<VerificationReport>;
export function renderMarkdown(report: VerificationReport): string;
export function main(args?: string[], env?: NodeJS.ProcessEnv): Promise<number>;
