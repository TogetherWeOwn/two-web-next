// Builder-owned direct contract for src/privacy-history.ts. The RED acceptance
// suite (test/privacy-published-history.acceptance.test.ts, author-owned)
// exercises the same authority through the SSR fixture bundle, which V8
// coverage cannot attribute back to this module — so this file pins the
// module-level behavior directly: exact eligible set, stable ids, ordering,
// href construction, local checker outcomes and offline source integrity.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POLICY_VERSION } from "../src/privacy";
import { checkPublishedPolicyTarget, PREVIOUS_PUBLISHED_POLICIES } from "../src/privacy-history";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("previous published policy metadata authority", () => {
  it("lists exactly the production-confirmed earlier set, newest-first, with stable ids", () => {
    expect(PREVIOUS_PUBLISHED_POLICIES.map(({ id }) => id)).toEqual(["v5"]);
    for (const [index, entry] of PREVIOUS_PUBLISHED_POLICIES.entries()) {
      expect(entry.version).toBeLessThan(POLICY_VERSION);
      expect(entry.id).toBe(`v${entry.version}`);
      if (index > 0)
        expect(PREVIOUS_PUBLISHED_POLICIES[index - 1]!.version).toBeGreaterThan(entry.version);
      expect(entry.sourcePath).toBe(`content/privacy-policy-v${entry.version}.md`);
      expect(entry.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.href).toBe(
        `https://github.com/TogetherWeOwn/two-web-next/blob/${entry.sourceCommit}/${entry.sourcePath}`,
      );
      const url = new URL(entry.href);
      expect(url.username + url.password + url.search + url.hash).toBe("");
    }
  });

  it("pins the v5 entry to its verified retained source, offline", () => {
    const entry = PREVIOUS_PUBLISHED_POLICIES[0]!;
    expect(entry.sourceCommit).toBe("1846a6f2fbf2c956b07f72fb8c0eee76cb92c0ad");
    expect(
      execFileSync("git", ["hash-object", entry.sourcePath], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe("77d7b1c75f5b9f0df93971facaec890ab4eddd75");
    expect(
      execFileSync("git", ["ls-files", "--error-unmatch", entry.sourcePath], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe(entry.sourcePath);
  });

  it("resolves the eligible stable id to its own entry", () => {
    const entry = PREVIOUS_PUBLISHED_POLICIES[0]!;
    expect(checkPublishedPolicyTarget(entry.id)).toEqual({ ok: true, target: entry });
  });

  it.each(["v1", "v2", "v3", "v4", "v6", "v7", "v0", "v999", "latest", ""])(
    "refuses current/future/unpublished/unknown target %j locally with bounded remediation",
    (id) => {
      const result = checkPublishedPolicyTarget(id);
      expect(result).toMatchObject({
        ok: false,
        code: "unknown_policy_version",
        retryable: false,
      });
      if (result.ok) throw new Error("unreachable: typed false branch");
      expect(result.next_action).toMatch(/published|version|privacy/i);
      expect(result.next_action.length).toBeGreaterThan(10);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(512);
    },
  );

  it("does not reflect an oversized unknown id in its bounded failure", () => {
    const result = checkPublishedPolicyTarget("unpublished-".repeat(2048));
    expect(result).toMatchObject({
      ok: false,
      code: "unknown_policy_version",
      retryable: false,
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(result)).not.toContain("unpublished-".repeat(8));
  });
});
