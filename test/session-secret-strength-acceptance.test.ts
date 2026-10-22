// route-inventory: GET /up
// Acceptance (test files only) for the SESSION_SECRET strength gate.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Oracle: the existing readiness refusal seam. `GET /up` already answers 503
// with a `config` key when a required Worker secret is absent or empty, and
// `configReadiness` is the unit seam behind it. A weak SESSION_SECRET must
// refuse the same way; a valid one must leave the ready body byte-shape
// unchanged. This file pins only that observable behaviour, never a helper
// name, a new `config` token, or log wording beyond naming the requirement.
//
// Strength contract pinned here (the documented local-example minimum,
// "32+ random bytes", taken as the floor):
// - length at least 32, counted on the value as configured. Every boundary
//   fixture below is ASCII, so a character count and a UTF-8 byte count
//   agree; multibyte boundary counting is deliberately unpinned.
// - no leading or trailing whitespace: a whitespace-padded value is refused
//   as configured, never trimmed and silently accepted. Whitespace inside
//   the value is deliberately unpinned.
// - low-entropy-but-long values (for example one repeated character) are
//   deliberately unpinned in either direction: length is the documented
//   floor for randomly generated secrets, and no entropy estimator is
//   required by this contract.
//
// Refusal contract:
// - HTTP 503, `status: "degraded"`, a non-empty string `config` key, and the
//   database/queue measurements untouched (`db: "ok"` on the healthy
//   fixture), so the configuration fault is the isolated cause.
// - the response body names neither the secret nor its value (the existing
//   /up leak rule), sets no cookie, and stays `cache-control: no-store`.
// - the server-side log (warn or error) names SESSION_SECRET and the
//   requirement it failed, and never contains the planted value.
//
// Scope guard: the gate is SESSION_SECRET only. The Discord secrets in the
// base fixture are short ("client-secret", "bot-token", as in test/up.test.ts)
// and every valid case below proves they must not trip readiness. Signing
// behaviour itself is unchanged and out of scope; valid cases prove only
// that readiness still admits dev-shaped and rotation-shaped secrets
// (documented generation shapes: base64 of 32 or 48 random bytes, hex of
// 32 random bytes, and the long-standing 42-character test fixture).
//
// All fixtures are synthetic and patterned; no real secret is read.
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { configReadiness } from "../src/up";
import app from "./app";
import { healthSql } from "./helpers/up";

// 32 distinct ASCII characters: the exact-length boundary fixture. Distinct
// characters keep the case valid under a length floor alone.
const EXACT_32 = "0123456789abcdefghijklmnopqrstuv";
const BELOW_31 = EXACT_32.slice(0, 31);
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// `openssl rand -base64 48` shape: 64 base64 characters, no padding.
const ROTATION_BASE64_48_BYTES = BASE64_ALPHABET;
// `openssl rand -base64 32` shape: 43 base64 characters plus "=" padding.
const ROTATION_BASE64_32_BYTES = `${BASE64_ALPHABET.slice(0, 43)}=`;
// `openssl rand -hex 32` shape: 64 lowercase hex characters.
const ROTATION_HEX_32_BYTES = "0123456789abcdef".repeat(4);
// Planted sentinels: distinctive substrings that must never appear in a
// response body or a server-side log line.
const PLANTED_SHORT = "PLANTED9x";
const PLANTED_PADDED_CORE = `PLANTED-CORE-${EXACT_32.slice(0, 23)}`;

const healthyQueueRow = {
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  oldest_ready_wait_age_seconds: 12.5,
};

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  // Deliberately short: the strength gate must not reach these secrets.
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function envWithSecret(secret: unknown): Env {
  const env = {
    ...baseEnv,
    QUEUE_DEPTH_STORE: healthSql({ queue: [healthyQueueRow] }),
  } as Record<string, unknown>;
  if (secret === undefined) delete env.SESSION_SECRET;
  else env.SESSION_SECRET = secret;
  return env as Env;
}

function captureLogs() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    text: () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]),
    calls: () => warn.mock.calls.length + error.mock.calls.length,
    restore: () => {
      warn.mockRestore();
      error.mockRestore();
    },
  };
}

async function upWith(secret: unknown) {
  const logs = captureLogs();
  try {
    const res = await app.request("/up", {}, envWithSecret(secret));
    const text = await res.text();
    return { res, text, body: JSON.parse(text) as Record<string, unknown>, logs };
  } catch (failure) {
    logs.restore();
    throw failure;
  }
}

const REQUIREMENT_WORDS = /32|length|weak|strength|short|whitespace|padded|minimum|at least/i;

describe("SESSION_SECRET strength gate: weak secrets refuse /up readiness", () => {
  it.each([
    ["a single character", "x"],
    ["a short word", "short"],
    ["a planted short sentinel", PLANTED_SHORT],
    ["31 characters, one below the floor", BELOW_31],
    ["a value padded with spaces on both ends", `  ${PLANTED_PADDED_CORE}  `],
    ["a value with a leading tab", `\t${EXACT_32}`],
    ["a value with a trailing newline", `${EXACT_32}\n`],
    ["a value with a trailing CRLF", `${EXACT_32}\r\n`],
    ["31 characters plus one trailing space (raw length 32)", `${BELOW_31} `],
    ["a short core padded past raw length 32", `${" ".repeat(20)}abc${" ".repeat(20)}`],
  ])("answers 503 for %s, naming the requirement and never the value", async (_label, secret) => {
    const { res, text, body, logs } = await upWith(secret);
    try {
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
      // The configuration fault is the isolated cause: DB and queue stay ready.
      expect(body.status).toBe("degraded");
      expect(body.db).toBe("ok");
      expect(body.pending_migrations).toBe(0);
      expect(typeof body.config).toBe("string");
      expect(body.config as string).not.toBe("");
      expect(body.queue).toMatchObject({ status: "healthy", pending: 3, failed: 2 });
      // The public body names neither the secret nor its value. Value-based:
      // single-character secrets collide with field-name substrings (the
      // pinned `migration_ledger_max` field contains "x"), so a leak is a
      // value that equals the secret — or embeds it, for longer secrets.
      const values: unknown[] = [];
      const collect = (node: unknown): void => {
        if (typeof node === "string") values.push(node);
        else if (Array.isArray(node)) node.forEach(collect);
        else if (node !== null && typeof node === "object")
          Object.values(node as Record<string, unknown>).forEach(collect);
      };
      collect(body);
      expect(values).not.toContain(secret.trim());
      if (secret.trim().length > 1) {
        for (const value of values) {
          if (typeof value === "string") expect(value).not.toContain(secret.trim());
        }
      }
      expect(text).not.toContain("SESSION_SECRET");
      expect(text).not.toContain("PLANTED");
      // Server-side only: the log names the secret and the requirement it
      // failed, and never carries the planted value.
      expect(logs.calls()).toBeGreaterThan(0);
      expect(logs.text()).toContain("SESSION_SECRET");
      expect(logs.text()).toMatch(REQUIREMENT_WORDS);
      expect(logs.text()).not.toContain(secret.trim());
      expect(logs.text()).not.toContain("PLANTED");
    } finally {
      logs.restore();
    }
  });

  it.each([
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["32 spaces (raw length at the floor, no secret)", " ".repeat(32)],
    ["an absent value", undefined],
    ["a null value", null],
    ["a numeric value", 12345678901234567890123456789012],
  ])("still answers 503 for %s (existing missing-secret refusal)", async (_label, secret) => {
    const { res, text, body, logs } = await upWith(secret);
    try {
      expect(res.status).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.db).toBe("ok");
      expect(body.config).toBe("missing");
      expect(text).not.toContain("SESSION_SECRET");
      expect(logs.text()).toContain("SESSION_SECRET");
    } finally {
      logs.restore();
    }
  });
});

describe("SESSION_SECRET strength gate: valid and rotation-shaped secrets stay ready", () => {
  it.each([
    ["exactly 32 characters", EXACT_32],
    ["the long-standing 42-character test fixture", "test-session-secret-at-least-32-bytes-long"],
    ["a base64 48-random-bytes rotation shape (64 chars)", ROTATION_BASE64_48_BYTES],
    ["a base64 32-random-bytes rotation shape (44 chars, padded)", ROTATION_BASE64_32_BYTES],
    ["a hex 32-random-bytes rotation shape (64 chars)", ROTATION_HEX_32_BYTES],
    ["a long 128-character secret", EXACT_32.repeat(4)],
  ])("answers 200 with the unchanged ready body for %s", async (_label, secret) => {
    const { res, text, body, logs } = await upWith(secret);
    try {
      expect(res.status).toBe(200);
      // A ready Worker adds nothing to the body besides informational
      // signals: no `config` key, same shape plus `member_access_log_enforcement`.
      expect(Object.keys(body).sort()).toEqual([
        "db",
        "member_access_log_enforcement",
        "migration_ledger_max",
        "pending_migrations",
        "queue",
        "status",
      ]);
      expect(body).toMatchObject({ status: "healthy", db: "ok", pending_migrations: 0 });
      expect(text).not.toContain(secret);
      expect(logs.text()).not.toContain(secret);
    } finally {
      logs.restore();
    }
  });
});

describe("SESSION_SECRET strength gate: configReadiness unit seam", () => {
  const ready = (secret: unknown) =>
    configReadiness({
      SESSION_SECRET: secret,
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
    });

  it.each([
    ["31 characters", BELOW_31],
    ["a padded otherwise-valid value", ` ${EXACT_32} `],
    ["a short planted sentinel", PLANTED_SHORT],
  ])("reports not-ready for %s without logging the value", (_label, secret) => {
    const logs = captureLogs();
    try {
      const readiness = ready(secret);
      expect(readiness).not.toEqual({});
      expect(typeof readiness.config).toBe("string");
      expect(readiness.config).not.toBe("");
      // The readiness object carries a fixed token, never the value.
      expect(JSON.stringify(readiness)).not.toContain(secret.trim());
      expect(logs.text()).not.toContain(secret.trim());
      expect(logs.text()).not.toContain("PLANTED");
    } finally {
      logs.restore();
    }
  });

  it.each([
    ["exactly 32 characters", EXACT_32],
    ["a base64 rotation shape", ROTATION_BASE64_48_BYTES],
    ["a hex rotation shape", ROTATION_HEX_32_BYTES],
  ])("adds nothing for %s", (_label, secret) => {
    const logs = captureLogs();
    try {
      expect(ready(secret)).toEqual({});
    } finally {
      logs.restore();
    }
  });
});
