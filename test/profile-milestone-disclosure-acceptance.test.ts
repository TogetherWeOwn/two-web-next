// Healthy transport/admission controls for the independently authored browser
// contract. Builder must preserve this file and the paired disclosure spec.
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  milestoneFixture,
  MILESTONE_OWNER,
  MILESTONE_VIEWER,
} from "./helpers/profile-milestone-disclosure";

afterEach(() => vi.unstubAllGlobals());

for (const renderer of ["Hono", "Kit"] as const) {
  describe(`${renderer} milestone disclosure read and privacy controls`, () => {
    for (const count of [0, 1, 5, 6, 100]) {
      for (const owner of [true, false]) {
        it(`${count} loaded rows, ${owner ? "owner" : "other"}: one keyed profile and stats read`, async () => {
          const fetch = vi.fn(() => {
            throw new Error("Unexpected remote transport");
          });
          vi.stubGlobal("fetch", fetch);
          const fixture = await milestoneFixture({ count, owner });
          const response = await fixture.request(renderer);
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Member profile remains editable");
          expect(html).not.toContain("Private viewer marker");
          expect(fixture.operations).toEqual([`find:${MILESTONE_OWNER}`]);
          expect(fixture.statsReads).toEqual([MILESTONE_OWNER]);
          expect(fetch).not.toHaveBeenCalled();
          if (owner) expect(fixture.audit).toEqual([]);
          else {
            expect(fixture.audit).toHaveLength(1);
            expect(fixture.audit[0]).toMatchObject({
              viewerUserId: MILESTONE_VIEWER,
              subjectUserIds: [MILESTONE_OWNER],
            });
          }
        });
      }
    }

    it("refuses an unauditable member read before releasing milestones", async () => {
      const fixture = await milestoneFixture({ count: 100, owner: false, auditOk: false });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).not.toContain("Loaded milestone");
      expect(html).not.toContain("Milestone fixture member");
      expect(fixture.audit).toHaveLength(1);
      expect(fixture.operations).toEqual([`find:${MILESTONE_OWNER}`]);
      // Existing reads finish before the final shared audit refuses the body.
      expect(fixture.statsReads).toEqual([MILESTONE_OWNER]);
    });

    for (const admission of [
      { guest: true, status: 302 },
      { member: false, status: 403 },
    ]) {
      it(`refuses admission (${admission.status}) without profile, audit or stats reads`, async () => {
        const fixture = await milestoneFixture({ count: 100, owner: false, ...admission });
        const response = await fixture.request(renderer);
        expect(response.status).toBe(admission.status);
        expect(await response.text()).not.toContain("Loaded milestone");
        expect(fixture.operations).toEqual([]);
        expect(fixture.statsReads).toEqual([]);
        expect(fixture.audit).toEqual([]);
      });
    }
  });
}
