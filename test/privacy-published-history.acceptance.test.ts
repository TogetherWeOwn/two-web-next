// route-inventory: GET /privacy
// route-inventory: GET /privacy.md
// Independent RED acceptance: navigation only; do not edit to fit an implementation.
// Run: npx vitest run test/privacy-published-history.acceptance.test.ts
// Browser companion: e2e/privacy-published-history.spec.ts (existing browser-smoke glob).
// Minimal public metadata seam (new src/privacy-history.ts):
// PREVIOUS_PUBLISHED_POLICIES: readonly { id: "vN", version: number, sourcePath,
// sourceCommit: full Git SHA, href: immutable public GitHub blob URL }[].
// checkPublishedPolicyTarget(id): {ok:true,target} or
// {ok:false,code:"unknown_policy_version",retryable:false,next_action:string}.
// This is a local check, not a new HTTP endpoint or a network link checker.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY_FILE, POLICY_VERSION, renderPolicyMarkdown } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import app from "./app";
import {
  compilePrivacyHistory,
  guardedPrivacyEnv,
  historyRoot,
  renderPrivacyHistory,
  type HistoryTarget,
  type PrivacyHistoryFixture,
} from "./helpers/privacy-published-history";

// Only independently confirmed production publication qualifies. Being tracked,
// lower-numbered, deployed to staging, or mentioned in a draft is insufficient.
// Evidence for v5: public release v1.0.0, target 754b10b39e2b52467240c9f29d5f8c8d85eefd33.
// Its v5 source blob is identical to the first v5 selector commit below.
const REQUIRED_PUBLISHED = [
  {
    id: "v5",
    version: 5,
    sourcePath: "content/privacy-policy-v5.md",
    sourceCommit: "1846a6f2fbf2c956b07f72fb8c0eee76cb92c0ad",
    blob: "77d7b1c75f5b9f0df93971facaec890ab4eddd75",
  },
] as const;

let fixture: PrivacyHistoryFixture;
let fetches: number;
beforeAll(async () => {
  fixture = await compilePrivacyHistory();
});
beforeEach(() => {
  fetches = 0;
  vi.stubGlobal("fetch", async () => {
    fetches += 1;
    throw new Error("Published history acceptance forbids external requests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function entries(): readonly HistoryTarget[] {
  expect(
    fixture.history.PREVIOUS_PUBLISHED_POLICIES,
    "PH-01: missing explicit previous-published metadata authority in src/privacy-history.ts",
  ).toBeInstanceOf(Array);
  return fixture.history.PREVIOUS_PUBLISHED_POLICIES!;
}

function historyList(html: string) {
  const heading = /<h2\b[^>]*>\s*Previous published versions\s*<\/h2>/i.exec(html);
  expect(
    heading,
    "PH-02: privacy must expose a native Previous published versions heading",
  ).not.toBeNull();
  const following = html.slice(heading!.index + heading![0].length);
  const list = /<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/i.exec(following);
  expect(list, "PH-02: history must be a native list, not JS-only controls").not.toBeNull();
  return { html: list![0], introduction: following.slice(0, list!.index) };
}

function links(html: string) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1]!,
    label: match[2]!,
  }));
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

describe("published privacy history: metadata and source integrity", () => {
  it("PH-01 requires stable IDs, descending order and evidence-backed eligible earlier sources", () => {
    const values = entries();
    expect(values.map(({ id }) => id)).toEqual(REQUIRED_PUBLISHED.map(({ id }) => id));
    expect(new Set(values.map(({ id }) => id)).size).toBe(values.length);
    for (const [index, value] of values.entries()) {
      expect(value.version).toBeLessThan(6);
      expect(value.id).toBe(`v${value.version}`);
      if (index > 0) expect(values[index - 1]!.version).toBeGreaterThan(value.version);
      expect(value.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(value.sourcePath).toBe(`content/privacy-policy-v${value.version}.md`);
      expect(value.href).toBe(
        `https://github.com/TogetherWeOwn/two-web-next/blob/${value.sourceCommit}/${value.sourcePath}`,
      );
      const url = new URL(value.href);
      expect(url.username + url.password + url.search + url.hash).toBe("");
      const evidence = REQUIRED_PUBLISHED.find(({ id }) => id === value.id)!;
      expect(value.sourceCommit).toBe(evidence.sourceCommit);
      // This verified public commit/path served the pinned blob. Check the
      // retained tracked source offline, including in CI's shallow Node 22 clone;
      // never fetch history or require old Git objects during a fixture run.
      const gitBlob = execFileSync("git", ["hash-object", value.sourcePath], {
        cwd: historyRoot,
        encoding: "utf8",
      }).trim();
      expect(gitBlob).toBe(evidence.blob);
      expect(
        execFileSync("git", ["ls-files", "--error-unmatch", value.sourcePath], {
          cwd: historyRoot,
          encoding: "utf8",
        }).trim(),
      ).toBe(evidence.sourcePath);
    }
    expect(fetches).toBe(0);
  });

  it.each([
    "v1",
    "v2",
    "v3",
    "v4",
    "v6",
    "v7",
    "v0",
    "v999",
    "latest",
    "",
    "../privacy-policy-v7.md",
    "https://example.test/",
  ])(
    "PH-03 refuses current/future/unpublished/unknown target %j locally with bounded remediation",
    async (id) => {
      expect(
        fixture.history.checkPublishedPolicyTarget,
        "PH-03: missing local target checker",
      ).toBeTypeOf("function");
      const result = (await fixture.history.checkPublishedPolicyTarget!(id)) as Record<
        string,
        unknown
      >;
      expect(result).toMatchObject({ ok: false, code: "unknown_policy_version", retryable: false });
      expect(result.next_action).toBeTypeOf("string");
      expect(String(result.next_action)).toMatch(/published|version|privacy/i);
      expect(String(result.next_action).length).toBeGreaterThan(10);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(512);
      expect(fetches).toBe(0);
    },
  );

  it("PH-03b does not reflect an oversized unknown ID in its bounded failure", async () => {
    expect(
      fixture.history.checkPublishedPolicyTarget,
      "PH-03b: missing local target checker",
    ).toBeTypeOf("function");
    const result = await fixture.history.checkPublishedPolicyTarget!("unpublished-".repeat(2048));
    expect(result).toMatchObject({ ok: false, code: "unknown_policy_version", retryable: false });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(512);
    expect(fetches).toBe(0);
  });

  it("PH-04 resolves every eligible stable ID to the same checked target, never a guessed latest URL", async () => {
    for (const target of entries()) {
      expect(fixture.history.checkPublishedPolicyTarget).toBeTypeOf("function");
      const result = await fixture.history.checkPublishedPolicyTarget!(target.id);
      expect(result).toMatchObject({ ok: true, target });
    }
    expect(fetches).toBe(0);
  });
});

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} published history: executed route and HTML`, () => {
    it("PH-02 lists the exact authoritative targets with external and historical-not-current labels", async () => {
      const { html, status } = await renderPrivacyHistory(fixture, twin);
      expect(status).toBe(200);
      const list = historyList(html);
      expect(links(list.html).map(({ href }) => href)).toEqual(entries().map(({ href }) => href));
      const rows = [...list.html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(
        (match) => match[1]!,
      );
      expect(rows).toHaveLength(REQUIRED_PUBLISHED.length);
      for (const [index, row] of rows.entries()) {
        expect(row).toMatch(new RegExp(`Version\\s+${REQUIRED_PUBLISHED[index]!.version}\\b`, "i"));
        expect(row).toMatch(/GitHub|public repository/i);
        expect(`${list.introduction} ${row}`).toMatch(/historical|previous/i);
        expect(`${list.introduction} ${row}`).toMatch(/not (?:the )?current|no longer current/i);
      }
      const version = html.match(
        /<p\b[^>]*data-testid="privacy-version"[^>]*>([\s\S]*?)<\/p>/,
      )?.[1];
      expect(version).toMatch(/Version\s+6/);
      expect(version).toMatch(/current/i);
      expect(list.html).not.toMatch(/v6\.md|v7\.md|v999|javascript:/);
    });

    it("PH-C01 CONTROL preserves the current legal body, no JS, cache and zero state reads even with a cookie", async () => {
      const anonymous = await renderPrivacyHistory(fixture, twin);
      const signed = await renderPrivacyHistory(
        fixture,
        twin,
        "__Host-two_session=fixture.invalid",
      );
      expect(anonymous.status).toBe(200);
      expect(signed.html).toBe(anonymous.html);
      expect(signed.touches).toEqual([]);
      expect(signed.headers["cache-control"]).toBe("public, max-age=3600");
      expect(signed.headers["set-cookie"]).toBeUndefined();
      expect(signed.html).not.toMatch(/<script\b|data-island=/i);
      const body = signed.html.match(
        /<div\b[^>]*data-testid="privacy-policy"[^>]*>([\s\S]*?)<\/div>/,
      )?.[1];
      expect(body?.replace(/<!--[\s\S]*?-->/g, "")).toBe(renderPolicyMarkdown(POLICY_MARKDOWN));
      expect(fetches).toBe(0);
      if (twin === "Kit") expect(fixture.csr).toBe(false);
    });
  });
}

describe("published privacy history: machine alternate and valid controls", () => {
  it("PH-C04 CONTROL the verified v5 source pin is present and byte-correct without historical Git objects", () => {
    expect(
      execFileSync("git", ["hash-object", "content/privacy-policy-v5.md"], {
        cwd: historyRoot,
        encoding: "utf8",
      }).trim(),
    ).toBe("77d7b1c75f5b9f0df93971facaec890ab4eddd75");
    expect(
      execFileSync("git", ["ls-files", "--error-unmatch", "content/privacy-policy-v5.md"], {
        cwd: historyRoot,
        encoding: "utf8",
      }).trim(),
    ).toBe("content/privacy-policy-v5.md");
    expect(fetches).toBe(0);
  });

  it("PH-05 Markdown agrees with both native HTML lists, outside the unchanged current policy body", async () => {
    const { env, touches } = guardedPrivacyEnv();
    fixture.setEnv(env);
    const response = await fixture.request("/privacy.md");
    expect(response.status).toBe(200);
    const markdown = await response.text();
    const section = markdown.split("## Previous published versions\n")[1];
    expect(section, "PH-05: machine-readable privacy history is missing").toBeDefined();
    const mdTargets = [
      ...section!.matchAll(
        /\[[^\]]+\]\((https:\/\/github\.com\/TogetherWeOwn\/two-web-next\/blob\/[^)]+)\)/g,
      ),
    ].map((match) => match[1]);
    expect(mdTargets).toEqual(entries().map(({ href }) => href));
    expect(section).toMatch(/GitHub|public repository/i);
    expect(section).toMatch(/not (?:the )?current|no longer current/i);
    for (const twin of ["Hono", "Kit"] as const) {
      expect(
        links(historyList((await renderPrivacyHistory(fixture, twin)).html).html).map(
          ({ href }) => href,
        ),
      ).toEqual(mdTargets);
    }
    expect(markdown).toContain(POLICY_MARKDOWN.trimEnd());
    expect(touches).toEqual([]);
    expect(fetches).toBe(0);
  });

  it("PH-C02 CONTROL full Hono endpoints retain public caching, Markdown revalidation and no session side effects", async () => {
    const { env, touches } = guardedPrivacyEnv();
    for (const path of ["/privacy", "/privacy.md"]) {
      const plain = await app.request(path, {}, env);
      const cookie = await app.request(
        path,
        { headers: { cookie: "__Host-two_session=fixture.invalid" } },
        env,
      );
      expect(plain.status).toBe(200);
      expect(cookie.status).toBe(200);
      expect(cookie.headers.getSetCookie()).toEqual([]);
      expect(cookie.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(await cookie.text()).toBe(await plain.text());
      if (path.endsWith(".md")) {
        expect(plain.headers.get("content-type")).toContain("text/markdown");
        expect(plain.headers.get("etag")).toBeTruthy();
        const cached = await app.request(
          path,
          { headers: { "if-none-match": plain.headers.get("etag")! } },
          env,
        );
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe("");
      }
    }
    expect(touches).toEqual([]);
    expect(fetches).toBe(0);
  });

  it("PH-C03 CONTROL keeps v6 active and byte-identical, v7 inactive and historical bodies out of Kit's runtime graph", () => {
    expect(POLICY_VERSION).toBe(6);
    expect(POLICY_FILE).toBe("content/privacy-policy-v6.md");
    expect(sha256(POLICY_MARKDOWN)).toBe(
      "cca9fbc121ef722665bafb818b4aa3d87087a5fa2c2193de310595531fda9d7a",
    );
    expect(sha256(readFileSync(join(historyRoot, "src/privacy-content.ts")))).toBe(
      "5b259723f5a77db11ba29c28fdfeaa0739f4cc96726733e4c8766644b01712f6",
    );
    expect(
      fixture.modules.filter((path) => /content\/privacy-policy-v(?:[1-5]|7)\.md$/.test(path)),
    ).toEqual([]);
    expect(
      readFileSync(join(historyRoot, "content/privacy-policy-v7.md"), "utf8").length,
    ).toBeGreaterThan(0);
  });
});
