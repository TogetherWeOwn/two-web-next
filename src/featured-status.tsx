import type { FC } from "hono/jsx";

export type FeaturedWindow = {
  isPublished: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type FeaturedStatus = "live" | "scheduled" | "expired" | "unpublished";

/** Match listVisibleFeatured: start inclusive, end exclusive, in UTC. */
export function featuredStatus(row: FeaturedWindow, now: Date = new Date()): FeaturedStatus {
  if (!row.isPublished) return "unpublished";
  if (row.startsAt && row.startsAt > now) return "scheduled";
  if (row.endsAt && row.endsAt <= now) return "expired";
  return "live";
}

export function currentlyVisible(row: FeaturedWindow, now: Date = new Date()): boolean {
  return featuredStatus(row, now) === "live";
}

export const FeaturedStatusBadge: FC<{ row: FeaturedWindow; now?: Date }> = ({ row, now = new Date() }) => {
  const status = featuredStatus(row, now);
  return <span class={`featured-status featured-status-${status}`} data-status={status}>{status}</span>;
};
