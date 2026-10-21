// Kit admin list legs alert before they rethrow. The two list loads own
// their store read directly in the server binding (the inventory suite
// documents why: cloudflare:workers imports keep them out of the root
// suite), so these are source pins on the alert-before-rethrow call shape,
// not behavioral probes. The identical call shape's fire/silent behavior is
// covered behaviorally by
// test/kit-admin-read-code-bug-alerts-acceptance.test.ts (the five resolver
// legs) and test/alerts.test.ts (mute dedupe, class-only, leak-free).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALERT_ROUTES } from "../tail/worker";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const LEGS = [
  {
    route: "/admin/join-attempts",
    load: "web/src/routes/admin/join-attempts/+page.server.ts",
  },
  {
    route: "/admin/events",
    load: "web/src/routes/admin/events/+page.server.ts",
  },
] as const;

describe("Kit admin list legs alert before they rethrow (source pins)", () => {
  it.each(LEGS)("$route: a code bug alerts with the stable route before the rethrow", (leg) => {
    const source = read(leg.load);
    expect(source).toContain('} from "../../../../../src/alerts"');
    // Exact call shape: class-only metadata, no request/trace identifiers.
    const call = `alertRequestError(err, { method: "GET", route: "${leg.route}" })`;
    expect(source).toContain(call);
    expect(call).not.toMatch(/request_id|requestId|subject|cookie/);
    // Order: outage maps first, then the diagnostic, then the rethrow.
    const outageAt = source.indexOf("isDatabaseUnavailable(err)");
    const alertAt = source.indexOf(call);
    const rethrowAt = source.indexOf("throw err;");
    expect(outageAt).toBeGreaterThan(-1);
    expect(alertAt).toBeGreaterThan(outageAt);
    expect(rethrowAt).toBeGreaterThan(alertAt);
  });

  it.each(LEGS)("$route: an outage or null database maps to 503 ahead of the alert", (leg) => {
    const source = read(leg.load);
    expect(source).toContain("if (isDatabaseUnavailable(err)) error(503");
    expect(source).toContain("if (!db) error(503");
    const alertAt = source.indexOf("alertRequestError(err,");
    expect(alertAt).toBeGreaterThan(-1);
    expect(source.indexOf("if (isDatabaseUnavailable(err)) error(503")).toBeLessThan(alertAt);
    expect(source.indexOf("if (!db) error(503")).toBeLessThan(alertAt);
  });

  it("both list routes are allowlisted so the tail forwards their diagnostics", () => {
    for (const leg of LEGS) {
      expect(ALERT_ROUTES.has(leg.route), `${leg.route} must stay in ALERT_ROUTES`).toBe(true);
    }
  });

  it("the runbook carries one row per new line", () => {
    const runbook = read("docs/runbook-logs.md");
    expect(runbook).toContain("Seven `error.alert` diagnostics, one per Kit admin read leg.");
    for (const leg of LEGS) {
      expect(runbook).toContain(`\`route\` \`${leg.route}\``);
      expect(runbook).toContain(`"route":"${leg.route}"`);
      expect(runbook).toContain(`<Class>@${leg.route}`);
    }
  });

  it("the join-attempts list comment names the branded-500 release, not a refusal", () => {
    const source = read("web/src/routes/admin/join-attempts/+page.server.ts");
    expect(source).not.toMatch(/boundary refuses it/);
    expect(source).toContain("branded 500 shell, which the hook's");
    expect(source).toContain("member-read boundary releases only after its audit decision");
  });
});
