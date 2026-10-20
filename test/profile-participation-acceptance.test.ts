// Missing, panel-only, or privileged-only Events links must fail independently
// of editor behavior. Refusal/read controls stay green on unchanged code.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  navigationLinks,
  ORIGIN,
  OWNER,
  participationFixture,
  VIEWER,
  type Presentation,
  type Renderer,
} from "./helpers/profile-participation";

const presentations: Presentation[] = ["new owner", "completed owner", "other member", "moderator"];
const renderers: Renderer[] = ["Hono", "Kit"];
afterEach(() => vi.unstubAllGlobals());

for (const renderer of renderers) {
  describe(`${renderer} profile participation: dispatched server-rendered HTML`, () => {
    it.each(presentations)(
      "preserves %s controls, privacy and the single keyed read",
      async (presentation) => {
        const fetch = vi.fn(() => {
          throw new Error("Unexpected external data read");
        });
        vi.stubGlobal("fetch", fetch);
        const fixture = await participationFixture(presentation);
        const response = await fixture.request(renderer);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Fixture member");
        expect(html).toContain('name="robots" content="noindex, nofollow"');
        expect(html).toContain('action="/logout"');
        expect(html).not.toContain("Private viewer marker");
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
        expect(fetch).not.toHaveBeenCalled();
        expect(fixture.statsReads).toEqual(renderer === "Kit" ? [OWNER] : []);
        expect(navigationLinks(html).some((link) => link.href === "/profile")).toBe(true);
        expect(html.includes('data-testid="profile-admin-link"')).toBe(
          presentation === "moderator",
        );
        expect(html.includes('data-testid="profile-form"')).toBe(presentation.endsWith("owner"));
        const panel = html.match(/<section\b[^>]*data-testid="profile-new-member"[^>]*>/)?.[0];
        expect(Boolean(panel && !/\bhidden(?:=|\s|>)/.test(panel))).toBe(
          presentation === "new owner",
        );
        if (presentation.endsWith("owner")) {
          expect(fixture.audit).toEqual([]);
          expect(html).toContain('name="leaderboard_opt_out"');
        } else {
          expect(html).not.toContain("Edit your profile");
          expect(html).not.toContain('name="leaderboard_opt_out"');
          expect(fixture.audit).toHaveLength(1);
          expect(fixture.audit[0]).toMatchObject({ viewerUserId: VIEWER, subjectUserIds: [OWNER] });
        }
      },
    );

    it.each(presentations)(
      "offers %s an ordinary Events link outside optional panels",
      async (presentation) => {
        const fixture = await participationFixture(presentation);
        const response = await fixture.request(renderer);
        expect(response.status).toBe(200);
        const html = await response.text();
        const eventLinks = navigationLinks(html).filter((link) => link.label === "Events");
        expect(
          eventLinks,
          "Primary navigation must offer Events, not just an onboarding CTA",
        ).toHaveLength(1);
        expect(eventLinks[0]!.href).toBe("/events");
        expect(eventLinks[0]!.attributes).not.toMatch(/\b(?:onclick|target|download)=/);
        expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
      },
    );

    it("offers a new owner distinct edit and event next steps without changing the edit anchor", async () => {
      const fixture = await participationFixture("new owner");
      const html = await (await fixture.request(renderer)).text();
      const panel = html.match(
        /<section\b[^>]*data-testid="profile-new-member"[^>]*>([\s\S]*?)<\/section>/,
      )?.[1];
      expect(panel, "Owner onboarding panel is present").toBeDefined();
      expect(panel).toMatch(/<a\b[^>]*href="#edit-heading"[^>]*>/);
      expect(panel, "New owners can find an event without first reopening the editor").toMatch(
        /<a\b[^>]*href="\/events"[^>]*>[^<]*event/i,
      );
    });

    it.each([
      { guest: true, status: 302 },
      { member: false, status: 403 },
    ])(
      "does not turn participation navigation into admission ($status)",
      async ({ status, ...options }) => {
        const fixture = await participationFixture("other member", options);
        const response = await fixture.request(renderer);
        expect(response.status).toBe(status);
        expect(await response.text()).not.toContain("Fixture member");
        expect(fixture.operations).toEqual([]);
        expect(fixture.audit).toEqual([]);
      },
    );

    it("refuses an unauditable other-member read before releasing the profile", async () => {
      const fixture = await participationFixture("other member", { auditOk: false });
      const response = await fixture.request(renderer);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("Fixture member");
      expect(fixture.audit).toHaveLength(1);
      expect(fixture.operations).toEqual([{ method: "find", args: [OWNER] }]);
    });

    it("leaves other-member writes self-only, including for moderators", async () => {
      const fixture = await participationFixture("moderator");
      const response = await fixture.request(renderer, `/members/${OWNER}`, {
        method: "PATCH",
        headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ bio: "Must not be written", games: [], timezone: "" }),
      });
      expect(response.status).toBe(403);
      expect(fixture.operations.some((operation) => operation.method === "save")).toBe(false);
      expect((await fixture.store.find(OWNER))!.bio).toBeNull();
    });
  });
}
