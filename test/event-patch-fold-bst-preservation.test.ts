// Builder-owned fold-carrier pin for the PATCH omitted-field merge
// (PR review on the concurrent-omitted-fields fix): wall 01:30 on fold
// Sunday 2099-10-25 names two instants — 00:30Z (BST, first) and 01:30Z
// (GMT, second) — and a fresh parse takes the GMT side. A title-only PATCH
// must keep whichever side is stored via the locked carriers passed to
// parseEventForm; without them the BST side silently moves to 01:30Z.
// Pure mergePatchInput pin, no DB: the acceptance suite owns the live race
// harness and is not edited here.
import { describe, expect, it } from "vitest";
import { mergePatchInput, type PatchBase } from "../src/admin/store";

const BASE: Omit<PatchBase, "startsAt" | "endsAt"> = {
  title: "Original title",
  game: null,
  description: null,
  timezone: "Europe/London",
  location: "Original hall",
  capacity: 5,
};

function baseAt(startsAt: string, endsAt: string): PatchBase {
  return { ...BASE, startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
}

describe("mergePatchInput preserves the stored fold side on omitted instants", () => {
  it("a title-only PATCH keeps a BST-side (00:30Z) fold instant", () => {
    const merged = mergePatchInput(baseAt("2099-10-25T00:30:00.000Z", "2099-10-25T03:00:00.000Z"), {
      title: "Fold-safe rename",
    });
    expect(merged.title).toBe("Fold-safe rename");
    expect(merged.startsAtUtc.toISOString()).toBe("2099-10-25T00:30:00.000Z");
    expect(merged.endsAtUtc.toISOString()).toBe("2099-10-25T03:00:00.000Z");
  });

  it("a title-only PATCH keeps a GMT-side (01:30Z) fold instant", () => {
    const merged = mergePatchInput(baseAt("2099-10-25T01:30:00.000Z", "2099-10-25T03:00:00.000Z"), {
      title: "Fold-safe rename",
    });
    expect(merged.title).toBe("Fold-safe rename");
    expect(merged.startsAtUtc.toISOString()).toBe("2099-10-25T01:30:00.000Z");
    expect(merged.endsAtUtc.toISOString()).toBe("2099-10-25T03:00:00.000Z");
  });
});
