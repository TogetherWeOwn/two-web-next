// TOG-12678: production web never dispatches CallInternalAction — drill/consumer only.
//
// Parity §6 records the contract: `bin/internal-action-drill.mjs` drives the
// real producer + consumer against staging (TOG-11706), and
// `test/internal-action-drill.test.ts:156` pins the handler only accepts
// role.assign/announcement.post. This suite pins the other half: no web route
// (src/index.tsx, src/worker.ts, src/events/*, src/admin/*, plus the sibling
// web families) enqueues or calls the internal-action path. A future route
// that silently wires production dispatch fails here.
//
// Shape: a runtime inventory scan over the mounted Hono app (every
// registration's path + handler source) plus a static scan of the web entry
// files for dispatch tokens. The only admitted INTERNAL_ACTION_QUEUE sender
// is the staging alert probe (`POST /__probe/alert`, kind alert-probe only —
// a QA-gated synthetic job, never announcement/role-assign). The only
// admitted drivers of the CallInternalAction producers/consumer are the queue
// consumer and the drill probe + CLI.
//
// Fixture-only: no staging dispatch, no network, no database.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import type { Env } from "../src/env";
import { env as baseEnv } from "./helpers/member-data";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

// Web entry surface: the card's named files plus the sibling families a
// future route could hide dispatch in. src/env.ts is deliberately excluded:
// it declares the INTERNAL_ACTION_QUEUE binding type (not a dispatch site);
// the send-site test below pins the only sender.
const WEB_ROOT_FILES = ["src/index.tsx", "src/worker.ts", "src/alert-probe.ts"];
const WEB_DIRS = ["src/events", "src/admin", "src/profiles", "src/join", "src/agent-events"];

function webFiles(): string[] {
  const out: string[] = [...WEB_ROOT_FILES];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
    }
  };
  for (const dir of WEB_DIRS) walk(`${dir}/`);
  return out.sort();
}

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
    }
  };
  walk("src/");
  return out.sort();
}

// Every way a web route could reach the internal-action path: the queued
// producers + consumer, the bot transport that speaks POST /internal/actions,
// the queue/job identity, and the action/kind literals a hand-built carrier
// would need. INTERNAL_ACTION_QUEUE itself is handled separately (the probe
// allowlist below); the quoted announcement kind is quoted on purpose so the
// GoingCount `announcement: null` prop in src/events/pages.tsx never matches.
const DISPATCH_TOKENS = [
  "dispatchAnnouncement",
  "dispatchRoleAssign",
  "handleCallInternalAction",
  "call-internal-action",
  "CALL_INTERNAL_ACTION",
  "CallInternalAction",
  "withInternalActionDeadline",
  "INTERNAL_ACTION_DEADLINE",
  "INTERNAL_ACTIONS_PATH",
  "signInternalAction",
  "createBotClient",
  "runInternalActionDrill",
  "runBotSmoke",
  "internal-action-drill",
  "internal-action-deadline",
  "two-internal-action",
  "role-assign",
  "announcement.post",
  "role.assign",
  "/internal/actions",
  "postAnnouncement",
  "assignRole",
  "probes/internal-action-drill",
  "probes/bot-smoke",
  "bot/client",
  "bot/actions",
  "jobs/consumer",
  '"announcement"',
  "'announcement'",
];

type Hit = { file: string; lineNo: number; line: string; token: string };

function scanFiles(files: string[], tokens: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const token of tokens) {
        if (text.includes(token)) {
          hits.push({ file, lineNo: i + 1, line: text.trim(), token });
          break;
        }
      }
    });
  }
  return hits;
}

describe("CallInternalAction is never web-dispatched (TOG-12678)", () => {
  it("finds mounted routes at all", () => {
    expect(app.routes.length).toBeGreaterThan(10);
  });

  it("exposes no internal-action route path", () => {
    const hits = app.routes.filter((r) =>
      /internal-action|call-internal|\/internal\/actions/.test(r.path),
    );
    expect(hits).toEqual([]);
  });

  it("no mounted handler closes over the dispatch path", () => {
    const problems: string[] = [];
    for (const r of app.routes) {
      const source = Function.prototype.toString.call(r.handler);
      for (const token of DISPATCH_TOKENS) {
        if (source.includes(token)) {
          problems.push(`${r.method} ${r.path} handler embeds ${token}`);
          break;
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("no web entry file references the dispatch path", () => {
    expect(scanFiles(webFiles(), DISPATCH_TOKENS)).toEqual([]);
  });

  it("INTERNAL_ACTION_QUEUE is sent only by the staging alert probe, as alert-probe only", () => {
    const senders = srcFiles().filter((file) => read(file).includes("INTERNAL_ACTION_QUEUE"));
    // src/env.ts declares the binding type; src/alert-probe.ts is the send site.
    expect(senders).toEqual(["src/alert-probe.ts", "src/env.ts"]);
    const probe = read("src/alert-probe.ts");
    expect(probe).toContain('kind: "alert-probe"');
    expect(probe).not.toContain("announcement");
    expect(probe).not.toContain("role-assign");
    expect(probe).not.toContain("CallInternalAction");
  });

  it("the only producer/consumer drivers are the queue consumer and the drill", () => {
    const producers = read("src/jobs/call-internal-action.ts");
    expect(producers).toContain("export async function dispatchAnnouncement");
    expect(producers).toContain("export async function dispatchRoleAssign");
    expect(producers).toContain("export async function handleCallInternalAction");
    const importers = srcFiles().filter((file) =>
      /(?:import\s[^;]*?from\s+|require\s*\(\s*)["'][^"']*call-internal-action["']/.test(
        read(file),
      ),
    );
    expect(importers).toEqual(["src/jobs/consumer.ts", "src/probes/internal-action-drill.ts"]);
    expect(read("src/jobs/consumer.ts")).toContain("handleCallInternalAction");
    const drill = read("src/probes/internal-action-drill.ts");
    expect(drill).toContain("dispatchAnnouncement");
    expect(drill).toContain("dispatchRoleAssign");
    expect(drill).toContain("handleCallInternalAction");
    const cli = read("bin/internal-action-drill.mjs");
    expect(cli).toContain("runInternalActionDrill");
    expect(cli).toContain("probes/internal-action-drill");
  });
});

const probeToken = "test-only-probe-token";
const staging = { ...baseEnv, APP_URL: STAGING_APP_URL, QA_AUTH_TOKEN: probeToken };

function probeRequest(env: Env, headers: Record<string, string> = {}) {
  return app.request(
    new URL("/__probe/alert", env.APP_URL).toString(),
    {
      method: "POST",
      headers: { origin: new URL(env.APP_URL).origin, [QA_HEADER]: probeToken, ...headers },
    },
    env,
  );
}

describe("web queue behavior (fixture-only)", () => {
  it("the probe route sends alert-probe only, never announcement/role-assign", async () => {
    const queued: unknown[] = [];
    const send = async (body: unknown): Promise<void> => void queued.push(body);
    const res = await probeRequest({
      ...staging,
      INTERNAL_ACTION_QUEUE: { send } as unknown as Queue,
    });
    // The probe intentionally reaches the real 500 handler after the queue accepts.
    expect(res.status).toBe(500);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "alert-probe" });
    const body = queued[0] as Record<string, unknown>;
    expect(body["kind"]).not.toBe("announcement");
    expect(body["kind"]).not.toBe("role-assign");
  });

  it.each(["/discord", "/about", "/robots.txt"])(
    "database-free %s never touches the internal queue",
    async (path) => {
      const send = async (): Promise<void> => {
        throw new Error("web route must not send to INTERNAL_ACTION_QUEUE");
      };
      const env = {
        ...baseEnv,
        INTERNAL_ACTION_QUEUE: { send },
      } as unknown as Env;
      const res = await app.request(
        new URL(path, env.APP_URL).toString(),
        { method: "GET", headers: { origin: new URL(env.APP_URL).origin } },
        env,
      );
      expect([200, 302]).toContain(res.status);
    },
  );
});
