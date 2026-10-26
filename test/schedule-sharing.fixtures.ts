import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsx } from "hono/jsx/jsx-runtime";
import { HtmlEscapedCallbackPhase, resolveCallback } from "hono/utils/html";
import { type Browser, type Page } from "playwright";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export type CopyProbe = {
  calls: string[];
  pending: { resolve: () => void; reject: () => void }[];
  mode: string;
};
declare const window: { copyProbe: CopyProbe };
declare const document: { execCommand: (command?: string) => boolean };
declare const navigator: { clipboard?: { writeText(text: string): Promise<void> } };

export function renderedElements(html: string) {
  const result: { tag: string; attrs: Record<string, string>; text: string }[] = [];
  const text = (node: DefaultTreeAdapterMap["node"]): string =>
    "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  function walk(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node)
      result.push({
        tag: node.tagName,
        attrs: Object.fromEntries(node.attrs.map((a) => [a.name, a.value])),
        text: text(node).trim(),
      });
    if ("childNodes" in node) node.childNodes.forEach(walk);
  }
  walk(parse(html));
  return result;
}
import { EventsCalendarPage } from "../src/events/pages";
import { renderEventsHtml } from "../src/kit-events-html";
import type { CalendarState } from "../src/islands/contracts";

export const fixtureOrigin = "http://127.0.0.1:43719";
export const viewLabel = "Copy this schedule view";
export const committedView = "/events?game=Catan&past=1&page=2";
export const sharedSearch =
  "/events?q=caf%C3%A9+%22raid%22+%26+%E9%9B%AA&game=Catan+%26+Co&past=1&page=3";
export type Target = "hono" | "kit";

export function sharingData(state: CalendarState, appUrl: string) {
  return {
    state,
    upcoming: [
      {
        discordId: "schedule-sharing-fixture",
        status: "scheduled" as const,
        title: "Catan community evening",
        description: "A fixture, not a live event.",
        location: null,
        startsAt: new Date("2030-11-15T19:00:00Z"),
        endsAt: new Date("2030-11-15T21:00:00Z"),
      },
    ],
    past: [],
    zone: "Europe/London",
    now: new Date("2030-11-13T12:00:00Z"),
    totalPages: 4,
    emptyState: null,
    discordFailed: false,
    games: ["Catan", "Catan & Co", "Chess"],
    gameFilter: state.game?.trim() || null,
    member: false,
    session: null,
    moderator: false,
    inviteUrl: "https://discord.gg/example",
    appUrl,
    canonical: `${appUrl.replace(/\/+$/, "")}/events`,
    loginReturnTo: "/events",
    joinResult: null,
    queryTooLong: false as const,
  };
}

// These are admitted model snapshots, not an alternative implementation of the
// production URL normalizer. Expected copied bytes in the tests are literals.
export async function sharingHtml(
  target: Target,
  state: CalendarState,
  appUrl: string,
  returnTo = "/events",
) {
  const data = { ...sharingData(state, appUrl), loginReturnTo: returnTo };
  if (target === "kit") return (await renderEventsHtml(data, {})).body;
  return String(
    await resolveCallback(
      jsx(EventsCalendarPage, data).toString(),
      HtmlEscapedCallbackPhase.Stringify,
      false,
      {},
    ),
  );
}

export function fixtureState(url: URL): CalendarState {
  return {
    view: url.searchParams.get("view") === "calendar" ? "calendar" : "list",
    month: url.searchParams.get("month") || "2030-11",
    q: url.searchParams.get("q") || "",
    game: url.searchParams.get("game") || "",
    past: url.searchParams.get("past") === "1",
    page: Number(url.searchParams.get("page") || "1"),
  };
}

export async function fixturePage(
  browser: Browser,
  target: Target,
  options: {
    javaScriptEnabled?: boolean;
    path?: string;
    viewport?: { width: number; height: number };
  } = {},
) {
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    viewport: options.viewport ?? { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixtureOrigin) return route.abort();
    if (url.pathname === "/events") {
      return route.fulfill({
        contentType: "text/html",
        body: await sharingHtml(
          target,
          fixtureState(url),
          fixtureOrigin,
          url.pathname + url.search,
        ),
      });
    }
    const path = resolve("public", `.${url.pathname}`);
    if (path.startsWith(`${resolve("public")}/`)) {
      try {
        return await route.fulfill({ path });
      } catch {
        return route.fulfill({ status: 404, body: "Fixture asset not found" });
      }
    }
    return route.abort();
  });
  await clipboard(page);
  await page.goto(fixtureOrigin + (options.path ?? committedView));
  return { context, page };
}

// Control only the external clipboard boundary. Real markup, browser native
// activation, shipped scripts, MutationObserver and calendar admission stay real.
export async function clipboard(page: Page) {
  await page.addInitScript(() => {
    const state = {
      calls: [] as string[],
      pending: [] as { resolve: () => void; reject: () => void }[],
      mode: "success",
    };
    Object.assign(window, { copyProbe: state });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(text: string) {
          state.calls.push(text);
          if (state.mode === "throw") throw new Error("Fixture clipboard unavailable");
          if (state.mode === "reject") return Promise.reject(new Error("Fixture clipboard denied"));
          if (state.mode === "pending")
            return new Promise<void>((resolve, reject) => {
              state.pending.push({
                resolve,
                reject: () => reject(new Error("Fixture clipboard denied")),
              });
            });
          return Promise.resolve();
        },
      },
    });
    document.execCommand = () => false;
  });
}

export const shippedCopyBinder = readFileSync(resolve("public/islands/copy-link.js"), "utf8");
