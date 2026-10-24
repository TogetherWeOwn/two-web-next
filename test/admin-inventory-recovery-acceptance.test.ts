// Acceptance-owned: Builder implements the behavior, not edits these expectations.
// These contracts catch dropped filter resets, lossy first-page URLs, empty-inventory
// claims on past-end pages, and count/fallback reads added solely for recovery UI.
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileInventoryKit,
  inventoryRow,
  origin,
  renderInventory,
  type Inventory,
  type Renderer,
} from "./helpers/admin-inventory-recovery";

const renderers: Renderer[] = ["Hono", "Kit"];
const inventories: Inventory[] = ["events", "featured"];
const defaults = {
  events: { sort: "starts_at", order: "desc" },
  featured: { sort: "position", order: "asc" },
};
const genuine = { events: "No events yet.", featured: "No featured content yet." };
const noMatch = {
  events: "No events match these filters.",
  featured: "No featured content matches these filters.",
};

function decode(value: string) {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&#x27;": "'",
    "&lt;": "<",
    "&gt;": ">",
  };
  return value.replace(/&(?:amp|quot|#39|#x27|lt|gt);/g, (entity) => entities[entity]!);
}

// Read text tokens from rendered markup; this is not an HTML sanitizer.
function textOf(fragment: string) {
  return [...fragment.matchAll(/<!--[\s\S]*?-->|<(?:[^"'<>]|"[^"]*"|'[^']*')*>|([^<]+)/g)]
    .map((token) => token[1] ?? "")
    .join("");
}

// Inspect rendered anchors, never Svelte/TSX source or a production URL builder.
function links(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => {
    const attributes = match[1]!;
    const label = attributes.match(/aria-label="([^"]*)"/)?.[1] ?? textOf(match[2]!);
    return {
      name: decode(label).replace(/\s+/g, " ").trim(),
      href: decode(attributes.match(/href="([^"]*)"/)?.[1] ?? ""),
      rel: attributes.match(/rel="([^"]*)"/)?.[1],
    };
  });
}

function recovery(html: string, name: "Clear filters" | "First page of these results") {
  const found = links(html).filter((link) => link.name.startsWith(name));
  expect(found, `one native ${name} navigation control`).toHaveLength(1);
  expect(found[0]!.href, `${name} is not a JS-only or fragment action`).not.toMatch(
    /^(?:$|#|javascript:)/i,
  );
  return found[0]!.href;
}

function expectDestination(
  href: string,
  inventory: Inventory,
  expected: Record<string, string>,
  page = 1,
) {
  const url = new URL(href, origin);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe(`/admin/${inventory}`);
  expect(url.hash).toBe("");
  expect(Number(url.searchParams.get("page") ?? "1")).toBe(page);
  url.searchParams.delete("page");
  // Default omission and explicit defaults have identical normalized semantics.
  if (!url.searchParams.has("sort")) url.searchParams.set("sort", defaults[inventory].sort);
  if (!url.searchParams.has("order")) url.searchParams.set("order", defaults[inventory].order);
  expect([...url.searchParams.keys()].length).toBe(new Set(url.searchParams.keys()).size);
  expect(Object.fromEntries(url.searchParams)).toEqual(expected);
}

beforeAll(async () => {
  await compileInventoryKit();
}, 60_000);

for (const renderer of renderers) {
  for (const inventory of inventories) {
    describe(`${renderer} ${inventory} inventory recovery`, () => {
      it("CONTROL: first-page empty inventory remains honest and has no recovery loop", async () => {
        const result = await renderInventory(renderer, inventory);
        expect(result.status).toBe(200);
        expect(result.html).toContain(genuine[inventory]);
        expect(result.html).not.toContain(noMatch[inventory]);
        expect(result.html).not.toContain("No results on this page");
        expect(
          links(result.html).filter((link) =>
            /^(Clear filters|First page of these results)/.test(link.name),
          ),
        ).toEqual([]);
      });

      it.each([
        "?q=%20%20&sort=bogus&order=bogus&page=0&unrelated=drop",
        inventory === "events"
          ? "?status=bogus&series=bogus&fill=bogus&rsvp_open=bogus&sort=title&order=asc"
          : "?published=bogus&sort=updated_at&order=desc",
      ])("CONTROL: ineffective filters do not offer Clear filters (%s)", async (search) => {
        const result = await renderInventory(renderer, inventory, search);
        expect(result.status).toBe(200);
        expect(result.html).toContain(genuine[inventory]);
        expect(links(result.html).some((link) => link.name.startsWith("Clear filters"))).toBe(
          false,
        );
        expect(result.probe.queries).toHaveLength(1);
      });

      const effective =
        inventory === "events"
          ? [
              "q=missing",
              "status=published",
              "series=parent",
              "series=child",
              "series=standalone",
              "fill=full",
              "fill=has_seats",
              "fill=unlimited",
              "rsvp_open=0",
              "rsvp_open=1",
            ]
          : ["q=missing", "published=0", "published=1"];
      it.each(effective)(
        "clears effective %s on first-page no-match, retaining sort",
        async (filter) => {
          const sort =
            inventory === "events"
              ? { sort: "title", order: "asc" }
              : { sort: "updated_at", order: "desc" };
          const result = await renderInventory(
            renderer,
            inventory,
            `?${filter}&sort=${sort.sort}&order=${sort.order}`,
          );
          expect(result.status).toBe(200);
          expect(result.html).toContain(noMatch[inventory]);
          expect(result.html).not.toContain(genuine[inventory]);
          expect(result.html).not.toContain("No results on this page");
          expectDestination(recovery(result.html, "Clear filters"), inventory, sort);
          expect(
            links(result.html).some((link) => link.name.startsWith("First page of these results")),
          ).toBe(false);
        },
      );

      const cases: {
        search: string;
        previousPage?: number;
        retained: Record<string, string> & { sort: string; order: string };
      }[] =
        inventory === "events"
          ? [
              {
                search: "?page=2",
                previousPage: 1,
                retained: { sort: "starts_at", order: "desc" },
              },
              { search: "?page=87", retained: { sort: "starts_at", order: "desc" } },
              {
                search:
                  "?q=%20Caf%C3%A9+%26+%22games%22+%3Ctag%3E%20&status=published&series=child&fill=has_seats&rsvp_open=0&sort=title&order=asc&page=87&unrelated=drop",
                retained: {
                  q: 'Café & "games" <tag>',
                  status: "published",
                  series: "child",
                  fill: "has_seats",
                  rsvp_open: "0",
                  sort: "title",
                  order: "asc",
                },
              },
              {
                search:
                  "?q=missing&status=bogus&series=bogus&fill=bogus&rsvp_open=bogus&sort=bogus&order=bogus&page=87",
                retained: { q: "missing", sort: "starts_at", order: "desc" },
              },
            ]
          : [
              { search: "?page=2", previousPage: 1, retained: { sort: "position", order: "asc" } },
              { search: "?page=87", retained: { sort: "position", order: "asc" } },
              {
                search:
                  "?q=%20Caf%C3%A9+%26+%22games%22+%3Ctag%3E%20&published=0&sort=updated_at&order=desc&page=87&unrelated=drop",
                retained: {
                  q: 'Café & "games" <tag>',
                  published: "0",
                  sort: "updated_at",
                  order: "desc",
                },
              },
              {
                search: "?q=missing&published=bogus&sort=bogus&order=bogus&page=87",
                retained: { q: "missing", sort: "position", order: "asc" },
              },
            ];
      it.each(cases)(
        "recovers a past-end page without claiming the inventory is empty: $search",
        async ({ search, retained, previousPage = 86 }) => {
          const result = await renderInventory(renderer, inventory, search);
          expect(result.status).toBe(200);
          expect(result.html).toContain("No results on this page");
          expect(result.html).not.toContain(genuine[inventory]);
          expect(result.html).not.toContain(noMatch[inventory]);
          expectDestination(
            recovery(result.html, "First page of these results"),
            inventory,
            retained,
          );
          expectDestination(
            links(result.html).find((link) => link.rel === "prev")!.href,
            inventory,
            retained,
            previousPage,
          );
          expect(links(result.html).some((link) => link.rel === "next")).toBe(false);
          if ("q" in retained) {
            expectDestination(recovery(result.html, "Clear filters"), inventory, {
              sort: retained.sort,
              order: retained.order,
            });
          } else {
            expect(links(result.html).some((link) => link.name.startsWith("Clear filters"))).toBe(
              false,
            );
          }
          expect(result.html).not.toContain("<tag>");
        },
      );

      it("CONTROL: an empty past-end read stays single-query, private/no-store and read-only", async () => {
        const result = await renderInventory(renderer, inventory, "?q=missing&page=87");
        expect(result.status).toBe(200);
        expect(result.probe.queries).toHaveLength(1);
        expect(result.probe.queries[0]!.sql).toContain(
          `from "${inventory === "events" ? "events" : "featured_contents"}"`,
        );
        expect(result.probe.queries[0]!.sql).not.toMatch(/\bcount\s*\(/i);
        expect(result.probe.queries[0]!.params).toEqual(["%missing%", 26, 2150]);
        expect(result.probe.transactions).toBe(1);
        expect(result.probe.executions).toHaveLength(1);
        expect(result.probe.audits).toEqual([]);
        expect(result.headers.get("cache-control")).toContain("private");
        expect(result.headers.get("cache-control")).toContain("no-store");
        if (renderer === "Kit") expect(result.bindingCalls).toBe(1);
      });

      it("CONTROL: populated inventory keeps its table, row action and Previous/Next", async () => {
        const result = await renderInventory(
          renderer,
          inventory,
          "?page=2",
          Array.from({ length: 26 }, (_, i) => inventoryRow(inventory, i + 1)),
        );
        expect(result.status).toBe(200);
        expect(result.html).toContain(`data-testid="${inventory}-table"`);
        expect(result.html).toContain("Inventory fixture 1");
        expect(result.html).not.toContain("Inventory fixture 26");
        expect(result.html).not.toContain("No results on this page");
        expect(result.html).not.toContain(genuine[inventory]);
        expect(
          links(result.html).some((link) => link.name.startsWith("First page of these results")),
        ).toBe(false);
        expectDestination(
          links(result.html).find((link) => link.rel === "prev")!.href,
          inventory,
          defaults[inventory],
        );
        expectDestination(
          links(result.html).find((link) => link.rel === "next")!.href,
          inventory,
          defaults[inventory],
          3,
        );
        const editPath =
          inventory === "events" ? "/admin/events/inventory-fixture-1" : "/admin/featured/1";
        expect(links(result.html).some((link) => link.href === editPath)).toBe(true);
        if (renderer === "Hono" && inventory === "events") expect(result.html).toContain("Publish");
        expect(result.probe.queries).toHaveLength(inventory === "events" ? 2 : 1);
        expect(result.probe.audits).toEqual([]);
      });

      it("also offers Clear filters on populated results without disturbing paging", async () => {
        const search =
          inventory === "events"
            ? "?status=draft&rsvp_open=1&sort=title&order=asc&page=2"
            : "?published=1&sort=updated_at&order=desc&page=2";
        const retained =
          inventory === "events"
            ? { sort: "title", order: "asc" }
            : { sort: "updated_at", order: "desc" };
        const result = await renderInventory(renderer, inventory, search, [
          inventoryRow(inventory),
        ]);
        expect(result.status).toBe(200);
        expect(result.html).toContain("Inventory fixture 1");
        expectDestination(recovery(result.html, "Clear filters"), inventory, retained);
        expect(
          links(result.html).some((link) => link.name.startsWith("First page of these results")),
        ).toBe(false);
      });

      it.each(["guest", "member"] as const)(
        "CONTROL: %s admission never reaches inventory reads",
        async (admission) => {
          const result = await renderInventory(
            renderer,
            inventory,
            "?q=missing&page=87",
            [],
            admission,
          );
          expect(result.status).toBe(admission === "guest" ? 302 : 403);
          expect(result.probe.queries).toEqual([]);
          expect(result.probe.transactions).toBe(0);
          expect(result.probe.audits).toEqual([]);
          expect(result.bindingCalls).toBe(0);
          expect(result.html).not.toContain("First page of these results");
          expect(result.html).not.toContain("Clear filters");
        },
      );
    });
  }
}
