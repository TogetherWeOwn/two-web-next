// SvelteKit catastrophic-error fallback contract: web/src/error.html is the
// page served when SSR itself throws uncaught. SvelteKit does not validate
// its placeholders at build time, so pin them here: without both, the
// fallback silently degrades to a static page with no status or message.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fallback = readFileSync(join(root, "web/src/error.html"), "utf8");

describe("Kit catastrophic-error fallback", () => {
  it("carries both SvelteKit placeholders", () => {
    expect(fallback).toContain("%sveltekit.status%");
    expect(fallback).toContain("%sveltekit.error.message%");
  });

  it("stays a minimal valid document", () => {
    expect(fallback).toContain("<!doctype html>");
    expect(fallback).toContain('<html lang="en">');
    expect(fallback).toContain('<meta charset="utf-8" />');
  });
});
