// Read-only featured reuse: the new-slot form pre-fills editorial content
// from one bounded source ID. The GET never writes; publication, window and
// position keep new-form defaults, and identity is never copied.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { parseRecordId } from "./record-id";
import type { FeaturedEditRow } from "./store-featured";

export type FeaturedReuseValues = {
  title: string;
  body: string;
  url: string;
  image_url: string;
  image_alt: string;
  position: string;
  starts_at: string;
  ends_at: string;
};

const EMPTY: FeaturedReuseValues = {
  title: "",
  body: "",
  url: "",
  image_url: "",
  image_alt: "",
  position: "0",
  starts_at: "",
  ends_at: "",
};

export type FeaturedReuseOutcome =
  | { kind: "unavailable" }
  | { kind: "ok"; values: FeaturedReuseValues; notice: "prefill" | "recovery" | null };

type GetFeatured = (db: Db, id: number) => Promise<FeaturedEditRow | null>;

/**
 * Resolve the new form for both renderers. Ordinary traffic and an invalid
 * or duplicate `source` read nothing; a missing source recovers to the empty
 * form; a classified outage is unavailable, never an empty successful copy.
 */
export async function resolveFeaturedReuse(
  params: URLSearchParams,
  db: () => Promise<Db | null>,
  get: GetFeatured,
): Promise<FeaturedReuseOutcome> {
  const raw = params.getAll("source");
  if (raw.length === 0) return { kind: "ok", values: { ...EMPTY }, notice: null };
  const id = raw.length === 1 ? parseRecordId(raw[0]!) : null;
  if (id === null) return { kind: "ok", values: { ...EMPTY }, notice: "recovery" };
  const handle = await db();
  if (!handle) return { kind: "unavailable" };
  let row: FeaturedEditRow | null;
  try {
    row = await get(handle, id);
  } catch (err) {
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    throw err;
  }
  if (!row) return { kind: "ok", values: { ...EMPTY }, notice: "recovery" };
  return {
    kind: "ok",
    notice: "prefill",
    values: {
      title: row.title,
      body: row.body ?? "",
      url: row.url ?? "",
      image_url: row.imageUrl ?? "",
      image_alt: row.imageAlt ?? "",
      position: "0",
      starts_at: "",
      ends_at: "",
    },
  };
}
