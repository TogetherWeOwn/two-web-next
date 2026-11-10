// Composition regression: the real root +layout.server.ts load, merged into real
// board/profile data, reaches the real Svelte +page files through the Kit
// dispatch. Nulling the root flag or dropping a page prop turns this red.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import {
  BOARD,
  OTHER_PROFILE,
  SELF,
  kitMemberAuthFixture,
  memberAuthRenderers,
  restoredWriteCookie,
  type MemberAuthRenderers,
} from "./fixtures/kit-member-auth";

let render: MemberAuthRenderers;
beforeAll(async () => {
  render = await memberAuthRenderers();
});
afterAll(() => render?.dispose());

const NAV = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };
const FIRST_IN_MAIN =
  /<main\b[^>]*>(?:\s|<!--[^>]*-->)*<div role="status" tabindex="-1" data-testid="auth-error">You signed in again\. Your earlier changes were not saved\. Review and submit them again\.<\/div>/;
const consumed = (response: Response) =>
  response.headers
    .getSetCookie()
    .some((value) => value.startsWith(`${EXPIRED_WRITE_COOKIE}=`) && /Max-Age=0/i.test(value));

async function visit(
  path: string,
  restored: string | null,
  prepare: (f: ReturnType<typeof kitMemberAuthFixture>) => void = () => {},
) {
  const f = kitMemberAuthFixture(render);
  prepare(f);
  const login = await f.login();
  const cookie = restored ? `${login.cookie}; ${restored}` : login.cookie;
  const response = await f.request(path, { headers: { ...NAV, cookie } });
  return { response, html: await response.text() };
}

describe("restored-write notice through the real root load and pages", () => {
  it.each([BOARD, SELF, OTHER_PROFILE])(
    "%s shows the notice once, first in main, and consumes the cookie",
    async (path) => {
      const { response, html } = await visit(path, await restoredWriteCookie());
      expect(response.status).toBe(200);
      expect(html.match(/data-testid="auth-error"/g)).toHaveLength(1);
      expect(html).toMatch(FIRST_IN_MAIN);
      expect(consumed(response)).toBe(true);
    },
  );

  it.each([BOARD, SELF, OTHER_PROFILE])(
    "%s stays notice-free without a valid cookie",
    async (path) => {
      const cookies = [
        null,
        await restoredWriteCookie("pending|/events/42"),
        await restoredWriteCookie("restored|/events/42", "another-secret-that-is-long-enough"),
      ];
      for (const cookie of cookies) {
        const { response, html } = await visit(path, cookie);
        expect(html).not.toContain('data-testid="auth-error"');
        expect(consumed(response)).toBe(false);
      }
    },
  );

  it.each([BOARD, OTHER_PROFILE])(
    "%s leaves the cookie pending when the audit fails",
    async (path) => {
      const { response, html } = await visit(path, await restoredWriteCookie(), (f) => {
        f.state.auditFails = true;
      });
      expect(html).not.toContain('data-testid="auth-error"');
      expect(consumed(response)).toBe(false);
    },
  );

  it("profile pages keep forwarding shared games alongside the restored flag", () => {
    for (const page of ["profile", "members/[user]"]) {
      const source = readFileSync(
        new URL(`../web/src/routes/${page}/+page.svelte`, import.meta.url),
        "utf8",
      );
      expect(source).toContain("sharedGames={data.sharedGames}");
      expect(source).toContain("restoredWrite={data.restoredWrite}");
    }
  });
});
