import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { PublicEvent } from "../../src/events/reads";

type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];

export const scheduleSearchNow = new Date("2035-06-01T12:00:00Z");
export const lateSearchDescription = `${"An unrelated opening sentence. ".repeat(30)}Bring your NEEDLE deck; another needle deck is welcome. ${"More context. ".repeat(40)}`;

export function scheduleSearchEvent(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 1,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Friday tabletop night",
    description: lateSearchDescription,
    accessibilityNotes: null,
    game: "Tabletop",
    startsAt: new Date("2035-06-04T18:00:00Z"),
    endsAt: new Date("2035-06-04T20:00:00Z"),
    timezone: "UTC",
    location: "Voice lounge",
    organizer_name: "Community host",
    join_url: null,
    join_instructions: null,
    status: "published",
    capacity: 8,
    rsvpOpen: true,
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 1,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: scheduleSearchNow,
    updatedAt: scheduleSearchNow,
    icsSequence: 0n,
    goingCount: 3,
    goingOccupancy: 3,
    ...overrides,
  };
}

export function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

export function elements(node: Node, predicate: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  if ("tagName" in node && predicate(node)) found.push(node);
  if ("childNodes" in node) {
    for (const child of node.childNodes) found.push(...elements(child, predicate));
  }
  return found;
}

export function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}

export function tag(node: Node, name: string): Element[] {
  return elements(node, (element) => element.tagName === name);
}

export function testId(node: Node, id: string): Element[] {
  return elements(node, (element) => attribute(element, "data-testid") === id);
}

export function document(html: string) {
  return parse(html);
}

// The compact excerpt belongs to the native disclosure's summary. Short
// descriptions have no disclosure, so inspect only their description paragraph.
export function passage(card: Element): Element {
  const excerpt = elements(card, (element) =>
    (attribute(element, "class") ?? "").split(" ").includes("schedule-excerpt"),
  )[0];
  if (excerpt) return excerpt;
  const info = elements(card, (element) => attribute(element, "class") === "schedule-info")[0]!;
  const paragraphs = tag(info, "p");
  const description = paragraphs[paragraphs.length - 1];
  if (!description) throw new Error("Expected a visible description passage");
  return description;
}
