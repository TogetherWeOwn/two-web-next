// Featured-content create/edit form parser (W11). Pure move out of
// `./validation`, ports FeaturedContentForm rules. `./validation` re-exports
// every public name below, so all existing importers keep working untouched.

import { isFeaturedImageUrl } from "../image-policy";
import { fail, str, type FieldErrors } from "./validation-shared";
import { parseWall } from "./validation-wall-time";

export type FeaturedFormInput = {
  title: string;
  body: string | null;
  url: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  isPublished: boolean;
  position: number;
  startsAtUtc: Date | null;
  endsAtUtc: Date | null;
  // Dates serve existing callers; canonical UTC text carries PostgreSQL microseconds.
  startsAtUtcText?: string | null;
  endsAtUtcText?: string | null;
};

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse the featured-content create/edit form (ports FeaturedContentForm rules). */
export function parseFeaturedForm(
  data: Record<string, unknown>,
  imageHosts?: string,
): FeaturedFormInput {
  const fields: FieldErrors = {};
  const title = str(data.title);
  if (!title) fields.title = "Give it a headline.";
  else if ([...title].length > 255) fields.title = "Keep the headline to 255 characters.";
  // Postgres text cannot store NUL: reject it here so the form returns a
  // field-level 422 instead of a persistence failure. Only NUL is rejected
  // in this slice; all other characters keep today's behavior.
  if (title?.includes("\0")) fields.title = "Headline cannot contain NUL characters.";
  const body = str(data.body);
  // Featured body is the homepage slot's short editorial blurb: 1000 Unicode
  // code points after the existing trim, matching the site's long-text
  // ceiling (event description, profile bio). Astral characters count once,
  // like the 255 sibling fields. Non-strings stay null via str(), never an
  // over-max error. The 256 KiB transport cap still refuses first (413).
  if (body && [...body].length > 1000) fields.body = "Keep the body to 1000 characters.";
  if (body?.includes("\0")) fields.body = "Body cannot contain NUL characters.";
  const url = str(data.url);
  if (url && (url.length > 255 || !isHttpUrl(url)))
    fields.url = "Link is a full http(s) URL, or empty for no link.";
  // Postgres text cannot store NUL, and new URL() percent-encodes it (so
  // isHttpUrl still passes): reject it here for a field-level 422.
  if (url?.includes("\0")) fields.url = "Link cannot contain NUL characters.";
  const imageUrl = str(data.image_url);
  if (imageUrl && (imageUrl.length > 255 || !isFeaturedImageUrl(imageUrl, imageHosts))) {
    fields.image_url =
      "Image URL must be HTTPS on an approved public host, without credentials or a custom port (255 characters maximum).";
  }
  const imageAlt = str(data.image_alt);
  // TOG-8707: an image with no description is silent for screen-reader
  // visitors — the URL and its description arrive together or not at all.
  if (imageUrl && !imageAlt)
    fields.image_alt = "Describe the photo in one plain sentence for screen-reader visitors.";
  if (imageAlt && [...imageAlt].length > 255)
    fields.image_alt = "Keep the alt text to 255 characters.";
  if (imageAlt?.includes("\0")) fields.image_alt = "Alt text cannot contain NUL characters.";

  let position = 0;
  const posRaw = str(data.position);
  if (posRaw !== null) {
    position = Number(posRaw);
    if (!/^\d+$/.test(posRaw) || !Number.isSafeInteger(position) || position > 2147483647) {
      fields.position =
        "Position is a whole number from 0 to 2147483647; lower numbers appear first.";
    }
  }

  const startsRaw = str(data.starts_at);
  const endsRaw = str(data.ends_at);
  let startsAtUtc: Date | null = null;
  let endsAtUtc: Date | null = null;
  let startsAtUtcText: string | null = null;
  let endsAtUtcText: string | null = null;
  // The show-window is UTC on both sides (legacy labels it "(UTC)").
  for (const [raw, key] of [
    [startsRaw, "starts_at"],
    [endsRaw, "ends_at"],
  ] as const) {
    if (raw !== null) {
      if (/\sBC$/i.test(raw)) {
        fields[key] =
          "BC dates are not supported. Clear or replace this window bound with an AD date.";
        continue;
      }
      // Featured windows support PostgreSQL precision; event wall times still speak minutes.
      const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(raw);
      const wall = match && parseWall(match[1]!);
      const seconds = Number(match?.[2] ?? 0);
      const fraction = (match?.[3] ?? "").padEnd(6, "0");
      if (!wall || wall.y === 0 || seconds > 59)
        fields[key] =
          "Not a date and time (want YYYY-MM-DD HH:mm[:ss[.ffffff]], UTC; up to 6 fractional digits).";
      else {
        // Date.UTC maps years 0–99 to 1900–1999; featured years must stay literal.
        const instant = new Date(0);
        instant.setUTCFullYear(wall.y, wall.mo - 1, wall.d);
        instant.setUTCHours(wall.h, wall.mi, seconds, Number(fraction.slice(0, 3)));
        const text = `${instant.toISOString().slice(0, 19)}.${fraction}Z`;
        if (key === "starts_at") {
          startsAtUtc = instant;
          startsAtUtcText = text;
        } else {
          endsAtUtc = instant;
          endsAtUtcText = text;
        }
      }
    }
  }
  // Fixed-width UTC strings sort chronologically, even within one Date millisecond.
  if (startsAtUtcText && endsAtUtcText && endsAtUtcText <= startsAtUtcText)
    fields.ends_at = "The window ends after it starts.";

  if (Object.keys(fields).length > 0) fail(fields);
  return {
    title: title!,
    body,
    url,
    imageUrl,
    imageAlt,
    isPublished:
      data.is_published === "on" || data.is_published === true || data.is_published === "true",
    position,
    startsAtUtc,
    endsAtUtc,
    startsAtUtcText,
    endsAtUtcText,
  };
}
