import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { SESSION_COOKIE } from "../../src/session-cookie";
import { requireGithubRunner, requireTestDatabase } from "../ci-only.mjs";
import { kitFixtureSessionSecret, type ParityTarget, parityTargets } from "../kit-parity";

// Use this test for moderator evidence: network traces can carry Set-Cookie.
// Capture only explicit PNG attachments; other parity tests keep their trace settings.
export const moderatorTest = test.extend({ trace: "off" });
export const MODERATOR_FIXTURE_ACTOR = "900000000000009101";

type Viewport = { width: number; height: number };
type ModeratorFixture = {
  page: Page;
  sql: ReturnType<typeof postgres>;
  navigate(path: string, status: number, heading: string): Promise<void>;
  capture(name: string): Promise<void>;
};

async function cleanSession(sql: ModeratorFixture["sql"], hash: string): Promise<void> {
  try {
    // status_hash survives rotation and identifies only this fixture's lineage.
    await sql.begin(async (tx) => {
      await tx`delete from web_session_grace where status_hash = ${hash}`;
      await tx`delete from web_sessions where status_hash = ${hash}`;
    });
  } catch {
    throw new Error("Could not clean up synthetic moderator session");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function withModeratorFixture(
  browser: Browser,
  renderer: ParityTarget["name"],
  viewport: Viewport,
  run: (fixture: ModeratorFixture) => Promise<void>,
): Promise<void> {
  requireGithubRunner();
  const target = parityTargets().find(({ name }) => name === renderer);
  if (!target) throw new Error("Unknown moderator fixture renderer");
  let database: string;
  try {
    database = requireTestDatabase(process.env.DATABASE_URL);
    if (requireTestDatabase(process.env.KIT_WORKER_TEST_DATABASE_URL ?? database) !== database) {
      throw new Error("Mismatched Kit and Hono fixture databases");
    }
  } catch {
    throw new Error("Moderator evidence requires the shared disposable CI database");
  }
  const secret =
    renderer === "kit"
      ? kitFixtureSessionSecret()
      : readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(
          /^SESSION_SECRET=(.+)$/m,
        )?.[1];
  if (!secret) throw new Error("Missing moderator fixture session secret");
  // A Hono visit can rotate its bearer; a fresh context and lineage per
  // invocation prevent either renderer or a retry from sharing that token.
  const bearer = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(bearer).digest("hex");
  const signature = createHmac("sha256", secret).update(bearer).digest("base64");
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: target.ignoreHTTPSErrors,
    serviceWorkers: "block",
  });
  const sql = postgres(database, {
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 5_000 },
  });
  try {
    try {
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${hash}, ${hash}, ${MODERATOR_FIXTURE_ACTOR}, 'Synthetic Moderator', true, true, now() + interval '2 hours')`;
      await context.addCookies([
        {
          name: SESSION_COOKIE,
          value: `${bearer}.${signature}`,
          domain: new URL(target.origin).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    } catch {
      throw new Error("Could not install synthetic moderator session");
    }
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === target.origin
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    const page = await context.newPage();
    await run({
      page,
      sql,
      async navigate(path, status, heading) {
        const url = new URL(path, target.origin);
        if (url.origin !== target.origin) throw new Error("Expected a loopback fixture path");
        const response = await page.goto(url.href);
        expect(response?.url()).toBe(url.href);
        expect(response?.status()).toBe(status);
        expect(response?.headers()["x-two-renderer"]).toBe(renderer === "kit" ? "kit" : undefined);
        expect(response?.headers()["cache-control"]).toMatch(/\bno-store\b/);
        await expect(
          page.getByRole("heading", { level: 1, name: heading, exact: true }),
        ).toBeVisible();
      },
      async capture(name) {
        const label = `${renderer}-review-moderator-${name}-${viewport.width}`;
        const path = test.info().outputPath(`${label}.png`);
        await page.screenshot({ path, scale: "css" });
        await test.info().attach(label, { path, contentType: "image/png" });
      },
    });
  } finally {
    try {
      await context.close();
    } finally {
      await cleanSession(sql, hash);
    }
  }
}
