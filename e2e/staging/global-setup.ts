import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { QA_HEADER, STAGING_APP_URL } from "../../src/qa";
import { requireStagingOrigin } from "../staging-guard.mjs";
import { requireGithubRunner } from "../ci-only.mjs";
import { memberStorageState, moderatorStorageState } from "./fixtures";

const stagingOrigin = requireStagingOrigin(STAGING_APP_URL);

async function login(identity: "qa-member" | "qa-moderator", path: string): Promise<void> {
  const token = process.env.QA_AUTH_TOKEN;
  // The token arrives only as the staging Environment secret. A missing or
  // refused credential is a blocker, never a reason to substitute another.
  if (!token) throw new Error("Missing QA_AUTH_TOKEN staging Environment secret");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: stagingOrigin });
    // Same-origin gate needs the explicit staging Origin next to the header;
    // a bad token or unknown identity answers 404, never a redirect.
    const response = await context.request.post(`/auth/qa/${identity}`, {
      headers: { [QA_HEADER]: token, Origin: stagingOrigin },
      maxRedirects: 0,
    });
    assert.equal(response.status(), 204, `staging QA login as ${identity}`);
    // Persist only a real Set-Cookie session: the jar must hold the Secure
    // HttpOnly __Host- cookie for the staging host before it is saved.
    const cookie = (await context.cookies()).find((item) => item.name === "__Host-two_session");
    assert.match(cookie?.domain ?? "", /^(\.)?next\.togetherweown\.com$/);
    assert.equal(cookie?.httpOnly, true);
    assert.equal(cookie?.secure, true);
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  requireGithubRunner();
  await login("qa-member", memberStorageState);
  await login("qa-moderator", moderatorStorageState);
}
