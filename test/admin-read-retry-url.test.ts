import { resolve } from "node:path";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

let adminReadRetryHref: typeof import("../web/src/lib/admin-read-retry").adminReadRetryHref;

beforeAll(async () => {
  // Root Vitest does not run Kit's sync hook to resolve `$app/tsconfig`.
  const { outputFiles } = await build({
    entryPoints: [resolve("web/src/lib/admin-read-retry.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: {} },
    write: false,
  });
  const source = outputFiles[0]?.text;
  if (!source) throw new Error("Retry helper bundle is empty");
  const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ adminReadRetryHref } = await import(bundled));
});

const origin = "https://retry.example.test";

describe("admin read retry URL admission", () => {
  it("ignores the origin and fragment while preserving the encoded query", () => {
    const path = "/admin/activity-log?page=2&q=%22%3Cscript%3E&tag=one&tag=two";
    expect(adminReadRetryHref(new URL(`${path}#old-row`, origin), "admin")).toBe(path);
  });

  it.each([
    "/admin/events/01ARZ3NDEKTSV4RRFFQ69G5FAV/publish",
    "/admin/events/01ARZ3NDEKTSV4RRFFQ69G5FAV/rsvp-pause",
    "/admin/featured/7/delete",
    "/admin/queue/failed/01ARZ3NDEKTSV4RRFFQ69G5FAV/redispatch",
    "/admin/events/delete",
    "/admin/events/logout",
    "/admin/events/%2f%2foutside.example",
    "/admin/events/key/extra",
    "/admin/join-attempts/7",
    "/profile",
  ])("does not admit %s into the general admin boundary", (path) => {
    expect(adminReadRetryHref(new URL(path, origin), "admin")).toBeNull();
  });

  it.each(["/admin/events", "/admin/join-attempts/0", "/admin/join-attempts/07"])(
    "does not admit %s into the join-attempt boundary",
    (path) => {
      expect(adminReadRetryHref(new URL(path, origin), "join-attempts")).toBeNull();
    },
  );

  it("contains an invalid native URL receiver", () => {
    expect(adminReadRetryHref(URL.prototype, "admin")).toBeNull();
  });

  it.each([undefined, null, {}, "/admin/events"])(
    "is total for an unavailable or malformed URL (%s)",
    (url) => {
      expect(adminReadRetryHref(url, "admin")).toBeNull();
    },
  );

  it("contains a throwing getter on an otherwise native URL", () => {
    const url = new URL("/admin/events", origin);
    Object.defineProperty(url, "pathname", {
      get() {
        throw new Error("unavailable page URL");
      },
    });
    expect(adminReadRetryHref(url, "admin")).toBeNull();
  });

  it.each(["?q=unsafe#fragment", "?q=raw\\slash", "?q=raw\nline", "not-a-query"])(
    "rejects malformed query state (%s)",
    (search) => {
      const url = new URL("/admin/events", origin);
      Object.defineProperty(url, "search", { value: search });
      expect(adminReadRetryHref(url, "admin")).toBeNull();
    },
  );
});
