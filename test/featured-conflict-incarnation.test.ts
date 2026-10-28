// Builder-owned review regressions; original stale-save acceptance stays unchanged.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { featuredContents } from "../src/db/admin-schema";
import {
  featuredSaveBaseline,
  getFeatured,
  StaleFeaturedSaveError,
  unpublishFeatured,
  updateFeatured,
} from "../src/admin/store";
import { parseFeaturedForm } from "../src/admin/validation";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const actor = { id: "333333333333333333", username: "moderator" };

describe("featured form incarnation (disposable Postgres)", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await fixture?.dispose();
  });

  it("refuses the original baseline after publish then Unpublish restores identical content", async () => {
    const [seed] = await fixture.db
      .insert(featuredContents)
      .values({
        title: "Originally unpublished",
        isPublished: false,
        position: 0,
      })
      .returning();
    const id = seed!.id;
    const original = (await getFeatured(fixture.db, id))!;
    const baseline = await featuredSaveBaseline(original);
    const input = parseFeaturedForm({ title: original.title, position: "0", is_published: "on" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00.123Z"));
    await updateFeatured(fixture.db, actor, id, input, { expectedBaseline: baseline });
    await expect(
      updateFeatured(fixture.db, actor, id, input, { expectedBaseline: baseline }),
    ).rejects.toBeInstanceOf(StaleFeaturedSaveError);
    await unpublishFeatured(fixture.db, actor, id);
    const withdrawn = (await getFeatured(fixture.db, id))!;
    expect(withdrawn.isPublished).toBe(false);
    expect(await featuredSaveBaseline(withdrawn)).not.toBe(baseline);
    await expect(
      updateFeatured(fixture.db, actor, id, input, { expectedBaseline: baseline }),
    ).rejects.toBeInstanceOf(StaleFeaturedSaveError);
    expect((await getFeatured(fixture.db, id))!.isPublished).toBe(false);
    // Explicit fresh review is still allowed after the withdrawal.
    await updateFeatured(fixture.db, actor, id, input, {
      expectedBaseline: await featuredSaveBaseline(withdrawn),
    });
    expect((await getFeatured(fixture.db, id))!.isPublished).toBe(true);
    vi.useRealTimers();
  });

  it("carries the locked conflicting snapshot without requiring a second database read", async () => {
    const [seed] = await fixture.db
      .insert(featuredContents)
      .values({
        title: "Before",
        isPublished: false,
        position: 0,
      })
      .returning();
    const id = seed!.id;
    const baseline = await featuredSaveBaseline((await getFeatured(fixture.db, id))!);
    await updateFeatured(
      fixture.db,
      actor,
      id,
      parseFeaturedForm({ title: "Committed successor" }),
    );
    const error = await updateFeatured(
      fixture.db,
      actor,
      id,
      parseFeaturedForm({ title: "Draft" }),
      {
        expectedBaseline: baseline,
      },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StaleFeaturedSaveError);
    expect(error).toHaveProperty("current.title", "Committed successor");
    expect((await getFeatured(fixture.db, id))!.title).toBe("Committed successor");
  });
});
