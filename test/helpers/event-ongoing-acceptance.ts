import { parse, type DefaultTreeAdapterMap } from "parse5";
import { expect } from "vitest";
import type { PublicEvent } from "../../src/events/reads";
import { NOW, event } from "../fixtures/schedule-availability";

type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];

// Semantic alternatives leave copy/design to the Builder, but not the state.
export const ONGOING = /\b(?:happening\s+now|ongoing|in[ -]progress)\b/i;
export const START = new Date("2035-10-20T11:00:00.000Z");
export const END = new Date("2035-10-20T13:00:00.000Z");
export const MID = NOW;
export const ongoingEvent = (over: Partial<PublicEvent> = {}) =>
  event({ startsAt: START, endsAt: END, ...over });

export function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

export function elements(node: Node, predicate: (element: Element) => boolean): Element[] {
  const matches: Element[] = [];
  if ("tagName" in node && predicate(node)) matches.push(node);
  if ("childNodes" in node) {
    for (const child of node.childNodes) matches.push(...elements(child, predicate));
  }
  return matches;
}

export const document = (html: string) => parse(html);

// Ignore markup, hidden nodes and raw-text bodies: an aria-label, JSON-LD or
// organizer description must never stand in for a visible snapshot badge.
export function visibleText(node: Node): string {
  if ("tagName" in node) {
    if (["script", "style", "template"].includes(node.tagName)) return "";
    if (attribute(node, "hidden") !== undefined || attribute(node, "aria-hidden") === "true") {
      return "";
    }
  }
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(visibleText).join(" ").replace(/\s+/g, " ").trim();
}

export function scheduleEntries(html: string, key: string, view: "list" | "calendar") {
  const rows = elements(document(html), (node) =>
    view === "list"
      ? node.tagName === "article" && attribute(node, "id") === `event-${key}`
      : node.tagName === "a" &&
        new URL(attribute(node, "href") ?? "", "https://fixture.example").searchParams.get(
          "event",
        ) === key,
  );
  expect(rows.length, `rendered ${view} entries for ${key}`).toBeGreaterThan(0);
  return rows;
}

export function hero(html: string): Element {
  const matches = elements(document(html), (node) =>
    (attribute(node, "class") ?? "").split(/\s+/).includes("event-hero"),
  );
  expect(matches, "exactly one detail hero").toHaveLength(1);
  return matches[0]!;
}

export function clientSurface(html: string) {
  const root = document(html);
  return {
    scripts: elements(
      root,
      (node) => node.tagName === "script" && attribute(node, "type") !== "application/ld+json",
    ).map((node) => ({
      src: attribute(node, "src") ?? null,
      body: node.childNodes.map((n) => ("value" in n ? n.value : "")).join(""),
    })),
    islands: elements(root, (node) => attribute(node, "data-island") !== undefined).map((node) =>
      attribute(node, "data-island"),
    ),
    handlers: elements(root, (node) => node.attrs.some((attr) => /^on/i.test(attr.name))).flatMap(
      (node) => node.attrs.filter((attr) => /^on/i.test(attr.name)),
    ),
  };
}

// Date only: real compiler and I/O timers must continue. No process-global
// frozen timers leak into a later test, even when a render/assertion rejects.
export async function at<T>(now: Date, work: () => Promise<T>): Promise<T> {
  const original = globalThis.Date;
  globalThis.Date = new Proxy(original, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [now.getTime()]);
    },
    get(target, key) {
      return key === "now" ? () => now.getTime() : Reflect.get(target, key);
    },
  });
  try {
    return await work();
  } finally {
    globalThis.Date = original;
  }
}
