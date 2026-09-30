import type { FC } from "hono/jsx";

export type FeaturedWindow = {
  isPublished: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type FeaturedContent = FeaturedWindow & {
  title: string;
  body: string | null;
  url: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
};

export type FeaturedStatus = "live" | "scheduled" | "expired" | "unpublished";

/** One UTC clock and inclusive window bounds for both admin and public rendering. */
export function featuredStatus(row: FeaturedWindow, now: Date = new Date()): FeaturedStatus {
  if (!row.isPublished) return "unpublished";
  if (row.startsAt && row.startsAt > now) return "scheduled";
  if (row.endsAt && row.endsAt < now) return "expired";
  return "live";
}

export function currentlyVisible(row: FeaturedWindow, now: Date = new Date()): boolean {
  return featuredStatus(row, now) === "live";
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

// Shared public item presenter; the homepage data/read path is a separate slice.
// Hono JSX escapes text and attributes: https://hono.dev/docs/guides/jsx#inserting-raw-html
export const FeaturedContentItem: FC<{ row: FeaturedContent; now?: Date }> = ({ row, now = new Date() }) => {
  if (!currentlyVisible(row, now)) return null;
  const url = httpUrl(row.url);
  const imageUrl = httpUrl(row.imageUrl);
  return (
    <article class="card featured-card" data-testid="featured-item">
      {imageUrl && row.imageAlt ? <img src={imageUrl} alt={row.imageAlt} loading="lazy" /> : null}
      <h3>{url ? <a href={url}>{row.title}</a> : row.title}</h3>
      {row.body ? <p class="featured-body">{row.body}</p> : null}
    </article>
  );
};

export const FeaturedStatusBadge: FC<{ row: FeaturedWindow; now?: Date }> = ({ row, now = new Date() }) => {
  const status = featuredStatus(row, now);
  return <span class={`featured-status featured-status-${status}`} data-status={status}>{status}</span>;
};
