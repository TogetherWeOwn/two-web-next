import { createRequire } from "node:module";
import { serializeSigned } from "hono/utils/cookie";
import { type DefaultTreeAdapterMap, Parser, type Token } from "parse5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy";
import { applyJoinPageResponsePolicy } from "../src/join/kit-page";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { attr } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const require = createRequire(import.meta.url);
const { renderedElements, renderedText } = require("../ci/rendered-page.mjs") as {
  renderedElements: (root: Node, selector: { tag?: string }) => Iterable<Element>;
  renderedText: (root: Node) => string;
};

const INVITE_URL = "https://discord.gg/invite";
const ONE_CLICK_HREF = "/join/discord?next=%2Fevents&source=web-homepage";

let renderPage: RenderPage;
let cleanup: (() => void) | undefined;

function parseResponse(html: string) {
  const parser = new Parser<DefaultTreeAdapterMap>({
    scriptingEnabled: false,
    onParseError: ({ code }) => expect(code).toBe("missing-doctype"),
  });
  // Capture decoded tokens before HTML tree correction can discard them.
  const tags: Token.TagToken[] = [];
  const text: string[] = [];
  const observe =
    <T>(record: (token: T) => void, handle: (token: T) => void) =>
    (token: T) => {
      record(token);
      handle.call(parser, token);
    };
  const recordText = ({ chars }: Token.CharacterToken) => text.push(chars);
  parser.onStartTag = observe((token) => tags.push(token), parser.onStartTag);
  parser.onCharacter = observe(recordText, parser.onCharacter);
  parser.onWhitespaceCharacter = observe(recordText, parser.onWhitespaceCharacter);
  parser.onComment = observe(({ data }) => text.push(data), parser.onComment);
  parser.onDoctype = () => expect.unreachable("The renderer emits head and body only");
  parser.tokenizer.write(html, true);
  const attrs = tags.flatMap((tag) => tag.attrs);
  const tagText = ({ tagName, attrs }: Token.TagToken) =>
    [tagName, ...attrs.map(({ name, value }) => `${name} ${value}`)].join(" ");
  const content = [text.join(""), ...tags.map(tagText)].join("\n");
  // Opaque token values can carry markup for client-side use.
  for (const match of content.matchAll(/(?=(href|aria-label|data-testid)="([^"]*)")/g)) {
    attrs.push({ name: match[1]!, value: match[2]! });
  }
  const values = (name: string) =>
    attrs.filter((attr) => attr.name.endsWith(name)).map((attr) => attr.value);
  return { page: parser.document, values, content };
}

function joinData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inviteUrl: INVITE_URL,
    widgetUrl: null,
    widgetSnapshot: null,
    oneClickHref: ONE_CLICK_HREF,
    appUrl: "https://example.test",
    joinResult: null,
    notice: null,
    restoredWrite: false,
    joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
    ...overrides,
  };
}

const testId = (element: Element) => attr(element, "data-testid");

const findByTestId = (root: Node, tag: string, id: string) =>
  [...renderedElements(root, { tag })].find((element) => testId(element) === id);

function expectJoinLinks(page: Node) {
  const links = [...renderedElements(page, { tag: "a" })];
  const oneClick = links.filter((link) => testId(link) === "join-oneclick");
  const invite = links.filter((link) => testId(link) === "join-invite");
  expect(oneClick.map((link) => attr(link, "href"))).toEqual([ONE_CLICK_HREF]);
  expect(invite.map((link) => attr(link, "href"))).toEqual([INVITE_URL]);
}

beforeAll(async () => {
  ({ renderPage, cleanup } = await createKitSsrRenderer("web/src/routes/join/+page.svelte"));
}, 60000);

afterAll(() => cleanup?.());

describe("Kit join SSR", () => {
  it("renders the safe handoff and invite fallback without a widget", () => {
    const { page, values } = parseResponse(renderPage(joinData()));
    expectJoinLinks(page);
    const fallback = findByTestId(page, "p", "join-widget-fallback");
    expect(fallback && renderedText(fallback)).toContain("Live server preview is unavailable");
    expect(values("data-testid")).not.toContain("join-widget-members");
  });

  it("shows a failed-start notice while keeping both join options available", () => {
    const { page, content } = parseResponse(renderPage(joinData({ notice: "start-failed" })));
    const notice = findByTestId(page, "p", "join-start-notice");
    expect(notice).toBeDefined();
    expect(notice && renderedText(notice)).toContain("The Discord approval failed to start");
    expectJoinLinks(page);
    expect(content).not.toContain("start-failed&");
  });

  it("renders the restored-write notice before a consumed join flash", () => {
    const data = joinData({ restoredWrite: true, joinResult: "added" });
    const { page, values } = parseResponse(renderPage(data));
    const noticeIds = ["auth-error", "join-result"];
    const notices = [...renderedElements(page, {})].filter((element) =>
      noticeIds.includes(testId(element) ?? ""),
    );
    expect(notices.map(testId)).toEqual(noticeIds);
    expect(values("data-testid").filter((id) => noticeIds.includes(id))).toEqual(noticeIds);
    const [restored, result] = notices;
    expect(restored && renderedText(restored)).toContain("Your earlier changes were not saved");
    expect(result && renderedText(result)).toContain(HOME_JOIN_RESULT_COPY.added);
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

    const { page, content } = parseResponse(
      await renderRequest(new Request(url, { headers: { cookie: cookie! } })),
    );
    const result = findByTestId(page, "p", "join-result");
    const reinvite = result && findByTestId(result, "a", "reinvite-link");
    expect(result && renderedText(result)).toContain(HOME_JOIN_RESULT_COPY.alreadyInServer);
    expect(reinvite && renderedText(reinvite)).toBe(HOME_JOIN_RESULT_COPY.reinvite);
    expect(reinvite && attr(reinvite, "href")).toBe("/discord");
    const added = HOME_JOIN_RESULT_COPY.added.toLowerCase();
    expect(content.replace(/\s+/g, " ").toLowerCase()).not.toContain(added);
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
    const next = parseResponse(await renderRequest(new Request(url)));
    expect(next.values("data-testid")).not.toContain("join-result");
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
      const { page, content } = parseResponse(html);
      const online = findByTestId(page, "p", "join-widget-online");
      const count = online && [...renderedElements(online, { tag: "strong" })].map(renderedText);
      const members = presenceCount === 1 ? "member online" : "members online";
      expect(count).toEqual([String(presenceCount)]);
      expect(online && renderedText(online).replace(/\s+/g, " ").trim()).toBe(
        `${presenceCount} ${members}`,
      );
      // Member names must stay out of attributes and inert markup as well as visible text.
      expect(content.replace(/\s+/g, " ")).not.toMatch(/private member name/i);
    }
  });
});
