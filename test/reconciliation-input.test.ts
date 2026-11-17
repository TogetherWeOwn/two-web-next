import { describe, expect, it } from "vitest";
import {
  reconciliationResolutionForm,
  reconciliationResolutionInput,
} from "../src/admin/reconciliation-input";

const key = "ABCDEF12-1234-1234-1234-123456789abc";

describe("reconciliation resolution input", () => {
  it("preserves the exact original key for each allowed resolution", () => {
    for (const resolution of ["confirmed", "not_applied", "superseded"]) {
      expect(reconciliationResolutionInput(key, resolution)).toEqual({ key, resolution });
    }
  });

  it("rejects malformed keys rather than normalizing them", () => {
    for (const invalid of [
      null,
      1,
      "",
      ` ${key}`,
      `${key} `,
      `${key}\n`,
      key.replace("-", ""),
      "x".repeat(36),
    ]) {
      expect(reconciliationResolutionInput(invalid, "confirmed")).toBeNull();
    }
  });

  it("admits exactly one bounded form field", () => {
    const form = new FormData();
    expect(reconciliationResolutionForm(key, form)).toBeNull();
    form.append("resolution", "confirmed");
    expect(reconciliationResolutionForm(key, form)).toEqual({ key, resolution: "confirmed" });
    form.append("resolution", "not_applied");
    expect(reconciliationResolutionForm(key, form)).toBeNull();
    form.delete("resolution");
    form.append("resolution", "confirmed");
    form.append("notes", "unexpected");
    expect(reconciliationResolutionForm(key, form)).toBeNull();
    form.delete("notes");
    form.set("resolution", new File(["confirmed"], "resolution.txt"));
    expect(reconciliationResolutionForm(key, form)).toBeNull();
  });

  it("rejects free text, ambiguous values, and non-string resolutions", () => {
    for (const invalid of [
      null,
      undefined,
      ["confirmed"],
      "",
      "Confirmed",
      "confirmed ",
      "notes",
    ]) {
      expect(reconciliationResolutionInput(key, invalid)).toBeNull();
    }
  });
});
