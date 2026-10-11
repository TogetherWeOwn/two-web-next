import type { FC } from "hono/jsx";
import type { VisibleFeatured } from "../featured";
import { featuredImageSrc } from "../featured-image";

export const FeaturedContentItem: FC<{
  row: VisibleFeatured;
  appUrl: string;
  imageHosts?: string;
}> = ({ row, appUrl, imageHosts }) => {
  const src = row.imageUrl ? featuredImageSrc(row.imageUrl, appUrl, imageHosts) : null;
  return (
    <article class="card" data-testid="featured-item">
      <h3>{row.url ? <a href={row.url}>{row.title}</a> : row.title}</h3>
      {row.body ? <p>{row.body}</p> : null}
      {src ? (
        <img
          class="featured-image"
          src={src}
          alt={row.imageAlt?.trim() || row.title}
          width="640"
          height="360"
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
        />
      ) : null}
    </article>
  );
};
