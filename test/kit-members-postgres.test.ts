import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { recordAccess } from "../src/admin/store";
import { boardViewLogs, memberDataAccessLogs } from "../src/db/admin-schema";
import { observeMemberReads } from "../src/db/member-reads";
import {
  loadMembersBoardData,
  queueMembersBoardView,
  recordQueuedMembersBoardView,
} from "../src/kit-members";
import { memberReadResponse } from "../src/member-reads";
import { MEMBER, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Real-Postgres proof for the review finding on the first version of this
// slice: the board-view INSERT must not run inside the member-read capture.
// The load only queues the view; memberReadResponse records it after the
// boundary releases a 200 (post-release hook, captures exited), exactly as
// the Hono handler writes it after memberReadBoundary returns. With the
// write inside the capture this drives to 503 with zero board_view_logs.
describe.skipIf(!process.env.DATABASE_URL)(
  "Kit member board through the boundary (real Postgres)",
  () => {
    let fixture: MemberDataFixture;
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      __resetAlertRateLimitForTests();
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
      return fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it("serves 200, writes one audit row and one anonymous board-view row", async () => {
      const connection = observeMemberReads(fixture.db);
      const locals: Record<string, unknown> = {};
      const res = await memberReadResponse(
        { method: "GET", route: "/leaderboards/members" },
        {
          resource: "leaderboard",
          action: "list",
          route: "leaderboards.members",
          viewer: MEMBER.userId,
        },
        (entry) => recordAccess(fixture.db, entry),
        async () => {
          const data = await loadMembersBoardData({
            env: { APP_URL: "https://next.example.test" } as never,
            session: { status: "authenticated", userId: MEMBER.userId, member: true },
            seasonParam: null,
            scopeParam: null,
            activityParam: null,
            setHeaders: () => {},
            dbForFn: async () => connection,
            queueBoardViewFn: (db, entry) => queueMembersBoardView(locals, db, entry),
          });
          return new Response(data.rows.map((row) => row.username).join(" "), { status: 200 });
        },
        (response) => recordQueuedMembersBoardView(locals, response.status),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(SUBJECT.username);
      const views = await fixture.db.select().from(boardViewLogs);
      expect(views).toMatchObject([
        { normalizedBoardKey: "members", scope: "overall", season: "all", resultCount: 1 },
      ]);
      const audits = await fixture.db.select().from(memberDataAccessLogs);
      expect(audits).toMatchObject([
        {
          viewerDiscordId: MEMBER.userId,
          resource: "leaderboard",
          action: "list",
          route: "leaderboards.members",
          subjectUserIds: [SUBJECT.userId],
        },
      ]);
    });
  },
);
