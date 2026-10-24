import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adminSaveStatus } from "../src/admin/save-status";

// The four Kit form twins inline the save-status markup instead of importing
// src/admin/save-status.ts: a module imported from four client entries splits
// its own shared chunk and breaches the client file-count cap in
// ci/kit-perf-budget.json. The module stays the single authority; these tests
// fail closed when a twin's copy drifts from it or re-adds the import.
const KIT_FORM_TWINS = [
  "web/src/routes/admin/events/new/+page.svelte",
  "web/src/routes/admin/events/[key]/+page.svelte",
  "web/src/routes/admin/featured/new/+page.svelte",
  "web/src/routes/admin/featured/[id]/+page.svelte",
];

describe("admin save-status copy", () => {
  it("keeps every Kit twin byte-identical to the shared authority", () => {
    expect(adminSaveStatus.length).toBeGreaterThan(0);
    for (const twin of KIT_FORM_TWINS) {
      const source = readFileSync(twin, "utf8");
      expect(source.includes(adminSaveStatus), twin).toBe(true);
    }
  });

  it("keeps the twins off the shared module so no client chunk splits", () => {
    for (const twin of KIT_FORM_TWINS) {
      const source = readFileSync(twin, "utf8");
      expect(source.includes("src/admin/save-status"), twin).toBe(false);
    }
  });
});
