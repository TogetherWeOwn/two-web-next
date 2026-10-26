// Test-owned literals; reuse the existing real route/compiled-Svelte fixture harness.
import { FeaturedPage } from "../../src/admin/pages/featured-list";
import { parseFeaturedListQuery } from "../../src/admin/featured-list-query";
import type { FeaturedEditRow } from "../../src/admin/store-featured";
import { compileInventoryKit, inventoryDb } from "./admin-inventory-recovery";

export const INVENTORY_NOW = new Date("2032-04-05T12:00:00.123Z");
export const INVENTORY_STATES = [
  "live",
  "scheduled",
  "expired",
  "unpublished",
  "unavailable",
] as const;
export type InventoryState = (typeof INVENTORY_STATES)[number];
export type InventoryParams = Record<string, string>;
export const INVENTORY_TWINS = ["Hono", "Kit"] as const;
export type InventoryTwin = (typeof INVENTORY_TWINS)[number];

export function inventoryRow(patch: Partial<FeaturedEditRow> = {}): FeaturedEditRow {
  return {
    id: 901,
    legacyId: null,
    title: "Healthy inventory sibling",
    body: null,
    url: null,
    imageUrl: null,
    imageAlt: null,
    isPublished: true,
    position: 3,
    startsAt: null,
    endsAt: null,
    startsAtText: null,
    endsAtText: null,
    createdBy: null,
    createdAt: new Date("2032-04-01T00:00:00.000Z"),
    updatedAt: new Date("2032-04-01T00:00:00.000Z"),
    ...patch,
  };
}

export async function loadKitInventory(
  search: string,
  db: unknown,
  parent: () => Promise<unknown> = async () => ({}),
) {
  const harness = await compileInventoryKit();
  const context = { db, calls: 0 };
  Reflect.set(globalThis, "__inventoryRecoveryAcceptanceBinding", context);
  const headers: Record<string, string> = {};
  try {
    const data = await harness.featuredLoad({
      url: new URL(`/admin/featured${search}`, "https://example.test"),
      parent,
      setHeaders: (values) => Object.assign(headers, values),
    });
    return { data, headers, dbReads: context.calls, html: harness.featuredRender(data) };
  } finally {
    Reflect.deleteProperty(globalThis, "__inventoryRecoveryAcceptanceBinding");
  }
}

export async function renderInventory(
  twin: InventoryTwin,
  rows: FeaturedEditRow[],
  params: InventoryParams = {},
  hasNext = false,
) {
  const query = parseFeaturedListQuery(params);
  if (twin === "Hono")
    return String(await FeaturedPage({ rows, query, hasNext, now: INVENTORY_NOW }));
  const fetched = hasNext
    ? [
        ...rows,
        ...Array.from({ length: Math.max(0, 26 - rows.length) }, (_, index) =>
          inventoryRow({ id: 1000 + index }),
        ),
      ]
    : rows;
  return (
    await loadKitInventory(`?${new URLSearchParams(params)}`, inventoryDb("featured", fetched).db)
  ).html;
}

export function inventoryIds(html: string): number[] {
  return [...html.matchAll(/data-testid="featured-position-(\d+)"/g)].map((match) =>
    Number(match[1]),
  );
}

export function inventoryText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function inventoryLinks(html: string): URL[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map(
    (match) => new URL(match[1]!.replaceAll("&amp;", "&"), "https://example.test"),
  );
}
