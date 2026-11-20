import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy";
import { applyJoinPageResponsePolicy } from "../src/join/kit-page";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let renderPage: RenderPage;
let cleanup: (() => void) | undefined;

function joinData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inviteUrl: "https://discord.gg/invite",
    widgetUrl: null,
    widgetSnapshot: null,
    oneClickHref: "/join/discord?next=%2Fevents&source=web-homepage",
    appUrl: "https://example.test",
    joinResult: null,
    notice: null,
    restoredWrite: false,
    joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
    ...overrides,
  };
}

beforeAll(async () => {
  ({ renderPage, cleanup } = await createKitSsrRenderer("web/src/routes/join/+page.svelte"));
}, 60000);

afterAll(() => cleanup?.());

describe("Kit join SSR", () => {
  it("renders the safe handoff and invite fallback without a widget", () => {
    const html = renderPage(joinData());
    expect(html).toContain('href="/join/discord?next=%2Fevents&amp;source=web-homepage"');
    expect(html).toContain('href="https://discord.gg/invite"');
    expect(html).toContain('data-testid="join-widget-fallback"');
    expect(html).not.toContain('data-testid="join-widget-members"');
  });

  it("shows a failed-start notice while keeping both join options available", () => {
    const html = renderPage(joinData({ notice: "start-failed" }));
    expect(html).toContain('data-testid="join-start-notice"');
    expect(html).toContain("The Discord approval failed to start");
    expect(html).toContain('href="/join/discord?next=%2Fevents&amp;source=web-homepage"');
    expect(html).toContain('href="https://discord.gg/invite"');
    expect(html).not.toContain("start-failed&amp;");
  });

  it("renders the restored-write notice before a consumed join flash", () => {
    const html = renderPage(joinData({ restoredWrite: true, joinResult: "added" }));
    expect(html).toContain(HOME_JOIN_RESULT_COPY.added);
    expect(html.indexOf('data-testid="auth-error"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="auth-error"')).toBeLessThan(
      html.indexOf('data-testid="join-result"'),
    );
  });

  it("renders the signed existing-member flash once without caching it", async () => {
    const sessionSecret = "join-render-fixture-signing-key";
    const url = "https://example.test/join";
    const [cookie] = (
      await serializeSigned(JOIN_RESULT_COOKIE, "already_member", sessionSecret, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";");
    const cookies = { delete: vi.fn() };
    const setHeaders = vi.fn();
    const renderRequest = async (request: Request) => {
      const data = await applyJoinPageResponsePolicy({
        request,
        sessionSecret,
        snapshot: null,
        cookies,
        setHeaders,
      });
      return renderPage(joinData(data));
    };

    const html = await renderRequest(new Request(url, { headers: { cookie: cookie! } }));
    expect(html).toContain(HOME_JOIN_RESULT_COPY.alreadyInServer);
    expect(html).toContain(HOME_JOIN_RESULT_COPY.reinvite);
    expect(html).toContain('href="/discord" data-testid="reinvite-link"');
    expect(html).not.toContain(HOME_JOIN_RESULT_COPY.added);
    expect(setHeaders).toHaveBeenLastCalledWith({
      "cache-control": "private, no-store",
      vary: "Cookie",
    });
    expect(cookies.delete).toHaveBeenCalledWith(JOIN_RESULT_COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });

    // The next request represents the browser after applying the cookie deletion.
    const next = await renderRequest(new Request(url));
    expect(next).not.toContain('data-testid="join-result"');
    expect(cookies.delete).toHaveBeenCalledTimes(1);
  });

  it("renders small presence counts literally without member names", () => {
    for (const presenceCount of [0, 1, 2]) {
      const html = renderPage(
        joinData({
          widgetSnapshot: {
            name: "Together We Own",
            presenceCount,
            inviteUrl: null,
            channels: [],
            members: [{ username: "Private Member Name" }],
          },
        }),
      );
      expect(html).toContain(`<strong>${presenceCount}</strong>`);
      expect(html).toContain(presenceCount === 1 ? "member online" : "members online");
      expect(html).not.toContain("Private Member Name");
    }
  });
});
