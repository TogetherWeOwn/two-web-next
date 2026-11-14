// route-inventory: GET /events/past
// Preserve the existing server-rendered row while its presentation changes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import {
  ARCHIVE_NOW,
  archiveReadFixture,
  archiveRow,
  compileArchiveKit,
  linksIn,
  requestArchive,
} from "./helpers/past-archive-search-acceptance";

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  kit = await compileArchiveKit();
}, 60_000);
afterAll(() => kit?.dispose());
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Kit archive event row", () => {
  it.each(["", "Raid"])('keeps the title and archive link in SSR for query %j', async (q) => {
    const source = archiveReadFixture();
    source.replaceRows([archiveRow(701, { title: "Raid night", eventKey: "raid-night" })]);
    const path = `/events/past?${new URLSearchParams({ q })}`;
    const response = await requestArchive("Kit", path, source.env, kit);
    expect(response.status).toBe(200);
    const html = await response.text();
    const card = /<li[^>]*data-event-key="raid-night"[\s\S]*?<\/li>/.exec(html)?.[0];
    expect(card).toBeDefined();
    const links = linksIn(card!);
    expect(links).toHaveLength(1);
    expect(links[0]!.label).toBe("Raid night");
    expect(links[0]!.url.pathname).toBe("/e/raid-night");
    expect(links[0]!.url.searchParams.get("archivePage")).toBe("1");
    expect(links[0]!.url.searchParams.get("archiveQuery")).toBe(q || null);
    expect(card).toContain('datetime="2020-01-01T20:00:00.000Z"');
    expect(card).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>/);
    expect(card).toContain("Sign-up record");
    if (q) expect(card).toMatch(/<mark[^>]*>Raid<\/mark>/);
  });
});
