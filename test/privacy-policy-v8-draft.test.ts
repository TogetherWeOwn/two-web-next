// Content contract for the unselected Version 8 privacy correction draft.
//
// Version 8 corrects v6's blanket "no third-party analytics or scripts"
// statement. It stays unselected until the operational evidence and release
// gates allow publication; switching POLICY_FILE is a separate change that
// must update the first block below and add v6 to src/privacy-history.ts.
// These are text checks only: they do not prove runtime script absence.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POLICY_FILE, POLICY_VERSION } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

const v6 = read("content/privacy-policy-v6.md");
const v8 = read("content/privacy-policy-v8.md");
const v8Flat = v8.replace(/\s+/g, " ");

/** Body of one `## ` section, up to the next heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

const paragraphs = (markdown: string): string[] =>
  markdown.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim());

describe("privacy policy v8 draft stays unpublished", () => {
  it("keeps v6 selected and the v8 text out of the bundle", () => {
    expect(POLICY_FILE).toBe("content/privacy-policy-v6.md");
    expect(POLICY_VERSION).toBe(6);
    expect(POLICY_MARKDOWN).toBe(v6);
    expect(POLICY_MARKDOWN).not.toContain("Version 8");
  });
});

describe("privacy policy v8 correction content", () => {
  it("drops the blanket third-party analytics and script denial", () => {
    expect(v8).not.toMatch(/There are no third-party analytics/);
    expect(v8).not.toMatch(/ships no JavaScript at all/);
    expect(v8).toContain("That was wrong");
  });

  it("discloses Zaraz advertising tags separately from Cloudflare Web Analytics", () => {
    const paras = paragraphs(section(v8, "Cookies and tracking"));
    const zaraz = paras.filter((p) => p.includes("Zaraz") && p.includes("Google Analytics 4"));
    expect(zaraz).toHaveLength(1);
    expect(zaraz[0]).toMatch(/Google Ads/);
    expect(zaraz[0]).toMatch(/Meta/);
    expect(zaraz[0]).not.toMatch(/cookie|Web Analytics/i);

    const rum = paras.filter((p) => p.includes("Cloudflare Web Analytics"));
    expect(rum.length).toBeGreaterThan(0);
    for (const p of rum) expect(p).not.toMatch(/Google|Meta|Zaraz/);
  });

  it("keeps historical unknowns and makes no unsupported claims", () => {
    expect(v8Flat).toMatch(/We do not know how long these tags were active/);
    expect(v8).not.toMatch(/\b129\b/);
    expect(v8).not.toMatch(/\b(has|have|was|were) been deleted\b|\bwere deleted\b/);
    expect(v8).not.toMatch(/\bcomplian(t|ce)\b/i);
    // Regional exclusion is not shipped; do not claim it.
    expect(v8).not.toMatch(/United Kingdom|European Union|\bEU\b|\bUK\b/);
  });

  it("describes the pause as configured, not as verified for every visitor", () => {
    const paras = paragraphs(section(v8, "Cookies and tracking"));
    const pause = paras.filter((p) => p.includes("06:36 UTC"));
    expect(pause).toHaveLength(1);
    expect(pause[0]).toMatch(/operator configured a rule/);
    expect(pause[0]).toMatch(/no country filter/);
    expect(pause[0]).toMatch(/single performance sample after the pause/);
    expect(v8Flat).not.toMatch(/\b(for|to) (every|all) visitors?\b/i);
    expect(v8Flat).not.toMatch(/\b(everyone|worldwide|globally)\b/i);
  });

  it("attributes Zaraz facts to the operator and leaves vendor receipt unknown", () => {
    const paras = paragraphs(section(v8, "Cookies and tracking"));
    const zaraz = paras.find((p) => p.includes("Google Analytics 4")) ?? "";
    expect(zaraz).toMatch(/^\*\*[^*]+\*\* Our operator reported/);
    expect(zaraz).toMatch(/no consent step was configured in Zaraz/);
    expect(zaraz).toMatch(/what Google or Meta received or kept/);
    expect(zaraz).not.toMatch(/still hold/);
    expect(v8Flat).not.toMatch(/with no consent step\b/);
  });

  it("uses Cloudflare's stated retention without a deletion deadline", () => {
    expect(v8Flat).toMatch(/stores unsampled Web Analytics data for 7 days/);
    expect(v8Flat).toMatch(/access data for the previous six months/);
    expect(v8Flat).toMatch(/not a promise about when every Cloudflare record is deleted/);
  });

  it("carries no unresolved editorial markers", () => {
    // The [O] class matches the same marker text; it only stops floor-guard's
    // stub matcher from reading this negative assertion as an unfinished stub.
    expect(v8).not.toMatch(/\[(VERIFY|BEFORE|ONLY|ADD|EXACT|ACCOUNT)\b|T[O]DO|TBD/);
  });

  it("changes nothing outside the cookies section and the change note", () => {
    for (const heading of [
      "Who we are, and what this covers",
      "What we store",
      "Who can see it",
      "Deletion",
    ])
      expect(section(v8, heading)).toBe(section(v6, heading));
    expect(section(v8, "Changes to this policy")).toContain(
      section(v6, "Changes to this policy").trimEnd(),
    );
    expect(v8.slice(0, v8.indexOf("## Cookies and tracking"))).toBe(
      v6.slice(0, v6.indexOf("## Cookies and tracking")),
    );
  });

  it("adds a Version 8 change note", () => {
    const changes = section(v8, "Changes to this policy");
    expect(changes).toMatch(/^Version 8 corrects /m);
    expect(changes).toMatch(/Version 7 was an unpublished draft/);
  });
});
