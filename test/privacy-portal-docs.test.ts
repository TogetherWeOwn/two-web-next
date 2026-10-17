import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POLICY_VERSION } from "../src/privacy";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(resolve(root, "docs/developer-portal-privacy.md"), "utf8");

describe("Developer Portal privacy-policy link documentation", () => {
  it("names the portal field and the /privacy path, and says the portal was not edited", () => {
    expect(doc).toContain("Privacy Policy URL");
    expect(doc).toContain("/privacy");
    expect(doc).toMatch(/not (?:been )?(?:edited|changed)/i);
  });

  it("points the portal at the version the page shows", () => {
    expect(doc).toContain(`Version ${POLICY_VERSION}`);
  });

  it("cites the 2026 review threshold and annual reapplication from Discord's own post", () => {
    expect(doc).toContain("10,000");
    expect(doc).toMatch(/every year|annual/i);
    expect(doc).toContain(
      "https://discord.com/blog/updated-requirements-to-how-apps-access-data-in-servers",
    );
  });

  it("keeps internal tracker IDs, repository and agent names out of the public doc", () => {
    expect(doc).not.toMatch(/TOG-|PAP-|Paperclip|two-bot|CISO|agent-/);
  });
});
