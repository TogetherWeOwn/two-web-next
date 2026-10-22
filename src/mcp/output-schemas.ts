// MCP success output schemas: the shapes tools/list advertises and the SDK
// validates success structuredContent against. Every shape's keys are typed
// as a Record over the canonical contracts.ts field list, so adding or
// removing a serializer field fails the build here until the advertised
// schema follows — never a second drifting field list. The per-field types
// mirror the OpenAPI component properties (same nullability, same published
// pin); formats stay unchecked (plain strings, no urls or datetimes) so
// output validation can never false-reject a real payload. Failures are
// untouched: the SDK skips validation for isError results, which carry no
// structuredContent.
import { z } from "zod";
import {
  COMMUNITY_RANK_FIELDS,
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  PUBLIC_API_COLLECTION_FIELDS,
  PUBLIC_API_EVENT_FIELDS,
  PUBLIC_API_META_FIELDS,
  PUBLIC_EVENT_STATUS,
} from "../public-data/contracts";

type EventField = (typeof PUBLIC_API_EVENT_FIELDS)[number];
type RankField = (typeof COMMUNITY_RANK_FIELDS)[number];
type CommunityField = (typeof COMMUNITY_SNAPSHOT_FIELDS)[number];
type JoinField = (typeof JOIN_HANDOFF_FIELDS)[number];
type CollectionField = (typeof PUBLIC_API_COLLECTION_FIELDS)[number];
type MetaField = (typeof PUBLIC_API_META_FIELDS)[number];

const eventShape: Record<EventField, z.ZodType> = {
  event_key: z.string(),
  title: z.string(),
  game: z.string().nullable(),
  description: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  starts_at_local: z.string(),
  ends_at_local: z.string(),
  timezone: z.string(),
  location: z.string().nullable(),
  capacity: z.number().int().nullable(),
  going_count: z.number().int().nullable(),
  going_occupancy: z.number().int().nullable(),
  status: z.enum([PUBLIC_EVENT_STATUS]),
  rsvp_open: z.boolean(),
  synced_to_discord: z.boolean(),
};

/** One published event: the get_event success shape and the list_events row. */
export const publicApiEventOutputSchema = z.object(eventShape);

const rankShape: Record<RankField, z.ZodType> = {
  key: z.string(),
  label: z.string(),
  member_count: z.number().int().nullable(),
};

const communityShape: Record<CommunityField, z.ZodType> = {
  member_count: z.number().int().nullable(),
  online_count: z.number().int().nullable(),
  ranks: z.array(z.object(rankShape)),
};

/** Community snapshot: unknown collectors read as null, never 0. */
export const communitySnapshotOutputSchema = z.object(communityShape);

const joinShape: Record<JoinField, z.ZodType> = {
  intro: z.string(),
  invite_url: z.string(),
};

/** Discord join handoff: intro copy plus the public invite URL. */
export const joinHandoffOutputSchema = z.object(joinShape);

const metaShape: Record<MetaField, z.ZodType> = {
  current_page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  last_page: z.number().int(),
};

const collectionShape: Record<CollectionField, z.ZodType> = {
  data: z.array(publicApiEventOutputSchema),
  page: z.number().int(),
  limit: z.number().int(),
  meta: z.object(metaShape),
};

/** Published-only collection envelope: rows are never dropped, paging stable. */
export const publicApiEventCollectionOutputSchema = z.object(collectionShape);
