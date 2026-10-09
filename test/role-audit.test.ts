import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareModeratorSets,
  InvalidRoleAuditInputError,
  renderRoleAuditReport,
  ROLE_AUDIT_MAX_SHOWN,
  roleAuditJson,
} from "../src/probes/role-audit";

const A = "508654771276873729";
const B = "100000000000000001";
const C = "100000000000000002";

describe("moderator role audit (fixture mappings)", () => {
  it("clean passes when the sets match regardless of order and duplicates", () => {
    const r = compareModeratorSets([B, A, A], [A, B]);
    expect(r.ok).toBe(true);
    expect(r.discordOnly).toEqual([]);
    expect(r.appOnly).toEqual([]);
    expect(r.discordCount).toBe(2);
    expect(r.appCount).toBe(2);
  });

  it("drift detected: discord-only and app-only are reported separately", () => {
    const r = compareModeratorSets([A, B], [B, C]);
    expect(r.ok).toBe(false);
    expect(r.discordOnly).toEqual([A]);
    expect(r.appOnly).toEqual([C]);
  });

  it("empty-safe: no moderators on either side is a clean pass", () => {
    const r = compareModeratorSets([], []);
    expect(r.ok).toBe(true);
    expect(renderRoleAuditReport(r)).toMatch(/CLEAN/);
  });

  it("one-sided emptiness is drift, not a clean pass", () => {
    expect(compareModeratorSets([A], []).ok).toBe(false);
    expect(compareModeratorSets([], [A]).ok).toBe(false);
  });

  it("whitespace and blank entries are ignored", () => {
    const r = compareModeratorSets([`  ${A} `, "", "  "], [A]);
    expect(r.ok).toBe(true);
  });

  it("malformed IDs are an input error, not silent drift", () => {
    expect(() => compareModeratorSets(["SySOp"], [A])).toThrow(InvalidRoleAuditInputError);
    expect(() => compareModeratorSets([A], ["abc"])).toThrow(InvalidRoleAuditInputError);
    expect(() => compareModeratorSets("not-an-array", [])).toThrow(InvalidRoleAuditInputError);
  });

  it("bounded report: large drift lists truncate with exact counts", () => {
    const discord = Array.from(
      { length: ROLE_AUDIT_MAX_SHOWN + 5 },
      (_, i) => `20000000000000${String(i).padStart(4, "0")}`,
    );
    const r = compareModeratorSets(discord, []);
    expect(r.ok).toBe(false);
    const text = renderRoleAuditReport(r);
    expect(text).toMatch(/…and 5 more/);
    expect(text).not.toContain(discord[discord.length - 1]!);
    const json = roleAuditJson(r) as {
      discordOnly: { shown: string[]; omitted: number };
      discordCount: number;
    };
    expect(json.discordOnly.shown).toHaveLength(ROLE_AUDIT_MAX_SHOWN);
    expect(json.discordOnly.omitted).toBe(5);
    expect(json.discordCount).toBe(ROLE_AUDIT_MAX_SHOWN + 5);
  });

  it("report never claims a mutation; it states the check is read-only", () => {
    const r = compareModeratorSets([A], [A]);
    expect(renderRoleAuditReport(r)).toMatch(/Read-only: no roles were changed/);
  });
});

describe("role-audit CLI", () => {
  const run = (args: string[], env: Record<string, string> = {}): { code: number; out: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        ["--import", "./bin/ts-hook.mjs", "bin/role-audit.mjs", ...args],
        { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 },
      );
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };
  const scratch = () => mkdtempSync(join(tmpdir(), "role-audit-"));
  const writeIds = (dir: string, name: string, ids: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof ids === "string" ? ids : JSON.stringify(ids));
    return path;
  };

  it("exit 0 on matching file sets, exit 1 on drift", () => {
    const dir = scratch();
    const discord = writeIds(dir, "discord.json", [A, B]);
    const app = writeIds(dir, "app.json", [B, A]);
    expect(run(["--discord-file=" + discord, "--app-file=" + app]).code).toBe(0);
    const drifted = writeIds(dir, "drift.json", [A]);
    const r = run(["--discord-file=" + discord, "--app-file=" + drifted]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/DRIFT/);
  });

  it("empty files on both sides pass; one-sided emptiness drifts", () => {
    const dir = scratch();
    const empty = writeIds(dir, "empty.txt", "");
    expect(run(["--discord-file=" + empty, "--app-file=" + empty]).code).toBe(0);
    const full = writeIds(dir, "full.json", [A]);
    expect(run(["--discord-file=" + full, "--app-file=" + empty]).code).toBe(1);
  });

  it("inline CSV sets work and --json stays bounded", () => {
    const r = run(["--discord-ids=" + A + "," + B, "--app-ids=" + B, "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as { ok: boolean; discordCount: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.discordCount).toBe(2);
  });

  it("exit 2 on missing side, both sources for one side, or malformed IDs", () => {
    const dir = scratch();
    const good = writeIds(dir, "good.json", [A]);
    expect(run(["--discord-file=" + good]).code).toBe(2);
    expect(run(["--discord-file=" + good, "--app-file=" + good, "--bogus"]).code).toBe(2);
    expect(run(["--discord-ids=" + A, "--discord-file=" + good, "--app-file=" + good]).code).toBe(
      2,
    );
    expect(run(["--discord-ids=SySOp", "--app-ids=" + A]).code).toBe(2);
  });

  it("never prints tokens or secrets from the environment", () => {
    const dir = scratch();
    const discord = writeIds(dir, "discord.json", [A]);
    const app = writeIds(dir, "app.json", [A]);
    const secret = "fixture-secret-token-abc123";
    const r = run(["--discord-file=" + discord, "--app-file=" + app], {
      DISCORD_BOT_TOKEN: secret,
      SESSION_SECRET: secret,
      DATABASE_URL: `postgres://user:${secret}@example.invalid/db`,
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(secret);
  });

  it("malformed file contents stay bounded and exit 2", () => {
    const dir = scratch();
    const bad = writeIds(dir, "bad.txt", `[${JSON.stringify("x".repeat(5000))}]`);
    const good = writeIds(dir, "good.json", [A]);
    const r = run(["--discord-file=" + bad, "--app-file=" + good]);
    expect(r.code).toBe(2);
    expect(r.out.length).toBeLessThan(2000);
  });
});
