// Independent saved-preview requirements. All dates and expected statuses are literal fixtures.
// Canonical commands and the protected-file manifest are attached to the acceptance handoff.
import type { FeaturedEditRow } from "../../src/admin/store-featured";

export const CHECKED_AT = new Date("2034-05-20T12:00:00.123Z");
export const APP_URL = "https://community.example.test";
export const SAVED_TITLE = "Saved community night";
export const SAVED_BODY = "Bring a favourite board game. Saved, not an unsent edit.";

export function savedFeatured(overrides: Partial<FeaturedEditRow> = {}): FeaturedEditRow {
  return {
    id: 41,
    legacyId: null,
    title: SAVED_TITLE,
    body: SAVED_BODY,
    url: "https://example.com/community-night",
    imageUrl: "https://cdn.discordapp.com/attachments/1/2/board.webp",
    imageAlt: "A table ready for board games",
    isPublished: true,
    position: 2,
    startsAt: new Date("2034-05-20T11:00:00.123Z"),
    endsAt: new Date("2034-05-20T13:00:00.123Z"),
    startsAtText: "2034-05-20 11:00:00.123000",
    endsAtText: "2034-05-20 13:00:00.123000",
    createdBy: "100000000000000001",
    createdAt: new Date("2034-05-19T11:00:00.000Z"),
    updatedAt: new Date("2034-05-20T10:00:00.000Z"),
    ...overrides,
  };
}

// Breaks caught: eligibility-gated card suppression; inclusive/exclusive drift;
// draft publication winning over the saved setting; missing open-bound explanations.
export const WINDOW_CASES = [
  {
    id: "SC01-unpublished",
    row: { isPublished: false },
    status: "unpublished",
    reason:
      /(?:not published|publication.{0,20}off|published.{0,20}(?:off|unchecked)|publish.{0,40}(?:before|to become eligible|to be eligible))/i,
  },
  {
    id: "SC02-scheduled",
    row: {
      startsAt: new Date("2034-05-20T12:00:00.124Z"),
      startsAtText: "2034-05-20 12:00:00.124000",
    },
    status: "scheduled",
    reason:
      /(?:not started|has not started|starts? (?:at|after|in)|before.{0,30}start|future.{0,30}(?:start|window)|start.{0,30}future)/i,
  },
  { id: "SC03-live", row: {}, status: "live", reason: /(?:eligible|inside.{0,30}window)/i },
  {
    id: "SC04-expired",
    row: {
      endsAt: new Date("2034-05-20T11:59:59.123Z"),
      endsAtText: "2034-05-20 11:59:59.123000",
    },
    status: "expired",
    reason:
      /(?:ended|end.{0,30}(?:reached|passed)|window.{0,30}closed|show until.{0,40}(?:passed|reached))/i,
  },
  {
    id: "SC05-exact-start",
    row: {
      startsAt: CHECKED_AT,
      startsAtText: "2034-05-20 12:00:00.123000",
    },
    status: "live",
    reason: /(?:eligible|inside.{0,30}window)/i,
  },
  {
    id: "SC06-exact-end",
    row: {
      endsAt: CHECKED_AT,
      endsAtText: "2034-05-20 12:00:00.123000",
    },
    status: "expired",
    reason:
      /(?:ended|end.{0,30}(?:reached|passed)|window.{0,30}closed|show until.{0,40}(?:passed|reached))/i,
  },
  {
    id: "SC07-open-start",
    row: { startsAt: null, startsAtText: null },
    status: "live",
    reason: /(?:eligible|inside.{0,30}window)/i,
  },
  {
    id: "SC08-open-end",
    row: { endsAt: null, endsAtText: null },
    status: "live",
    reason: /(?:eligible|inside.{0,30}window)/i,
  },
  {
    id: "SC09-open-both",
    row: { startsAt: null, startsAtText: null, endsAt: null, endsAtText: null },
    status: "live",
    reason: /(?:eligible|inside.{0,30}window)/i,
  },
  {
    id: "SC10-unpublished-before-start",
    row: {
      isPublished: false,
      startsAt: new Date("2034-05-20T12:00:00.124Z"),
      startsAtText: "2034-05-20 12:00:00.124000",
    },
    status: "unpublished",
    reason:
      /(?:not published|publication.{0,20}off|published.{0,20}(?:off|unchecked)|publish.{0,40}(?:before|to become eligible|to be eligible))/i,
  },
  {
    id: "SC11-unpublished-at-end",
    row: {
      isPublished: false,
      endsAt: CHECKED_AT,
      endsAtText: "2034-05-20 12:00:00.123000",
    },
    status: "unpublished",
    reason:
      /(?:not published|publication.{0,20}off|published.{0,20}(?:off|unchecked)|publish.{0,40}(?:before|to become eligible|to be eligible))/i,
  },
] satisfies {
  id: string;
  row: Partial<FeaturedEditRow>;
  status: "unpublished" | "scheduled" | "live" | "expired";
  reason: RegExp;
}[];
