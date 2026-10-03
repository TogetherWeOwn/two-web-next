import type { TableMapping } from "./verify.mjs";
export function defaultTableMap(options?: {
  legacySchema?: string;
  nextSchema?: string;
  cutoff?: string;
}): TableMapping[];
