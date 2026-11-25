import { describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { KitRequestSession } from "../src/kit-session";
import {
  DIRECTORY_READ_TIMEOUT_MS,
  DIRECTORY_ROW_LIMIT,
  type DirectoryCandidate,
  type DirectoryRow,
  type DirectorySource,
  memberDirectoryResponse,
} from "../web/src/lib/server/members-directory";

const viewerId = "1000000000";
const member: KitRequestSession = {
  status: "authenticated",
  session: { userId: viewerId, member: true, moderator: false, username: "Viewer", avatar: null },
};
const listed = {
  id: "2000000000",
  name: "Listed Fixture",
  currentMember: true,
  visibility: "listed",
  biography: "private-fixture-field",
  profileHref: "https://example.invalid/untrusted",
} as const;
const hidden = {
  ...listed,
  id: "3000000000",
  name: "Hidden Fixture",
  visibility: "hidden",
} as const;
const former = { ...listed, id: "4000000000", name: "Former Fixture", currentMember: false };

function setup(candidates: readonly DirectoryCandidate[] = [listed, hidden, former]) {
  const source = vi.fn<DirectorySource>(async () => candidates);
  const writeAudit = vi.fn(async (_entry: AccessEntry) => true);
  const render = vi.fn((rows: DirectoryRow[]) => Response.json(rows));
  return { session: member, source, writeAudit, render };
}

describe("dormant Kit members directory boundary", () => {
  it("checks the session and dependencies before any directory or audit work", async () => {
    const deps = setup();
    const nonMember: KitRequestSession = {
      ...member,
      session: { ...member.session!, member: false, moderator: true },
    };
    const invalidViewer: KitRequestSession = {
      ...member,
      session: { ...member.session!, userId: "invalid" },
    };
    const denials = [
      [{ ...deps, session: { status: "guest", session: null } }, 401],
      [{ ...deps, session: { status: "unknown", session: null } }, 503],
      [{ ...deps, session: nonMember }, 403],
      [{ ...deps, session: invalidViewer }, 503],
      [{ ...deps, source: undefined }, 503],
      [{ ...deps, writeAudit: undefined }, 503],
    ] as const;
    for (const [input, status] of denials) {
      const response = await memberDirectoryResponse(input);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("");
    }
    expect(deps.source).not.toHaveBeenCalled();
    expect(deps.writeAudit).not.toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("returns only listed current members and audits all retrieved owners before release", async () => {
    const unknownVisibility = { ...listed, id: "5000000000", visibility: undefined };
    const deps = setup([
      listed,
      hidden,
      former,
      unknownVisibility as unknown as DirectoryCandidate,
    ]);
    const response = await memberDirectoryResponse(deps);
    expect(deps.source).toHaveBeenCalledExactlyOnceWith({
      viewerId,
      limit: DIRECTORY_ROW_LIMIT,
      signal: expect.any(AbortSignal),
    });
    expect(deps.writeAudit).toHaveBeenCalledExactlyOnceWith({
      viewerDiscordId: viewerId,
      viewerUserId: viewerId,
      resource: "member-directory",
      action: "list",
      route: "members.directory",
      subjectUserIds: [listed.id, hidden.id, former.id, unknownVisibility.id],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual([
      { name: listed.name, profileHref: `/members/${listed.id}` },
    ]);
  });

  it("refuses buffered directory contents when the audit write fails", async () => {
    const deps = setup();
    deps.writeAudit.mockResolvedValue(false);
    const response = await memberDirectoryResponse(deps);
    expect(deps.render).toHaveBeenCalledOnce();
    expect(deps.writeAudit).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("Member data is temporarily unavailable.");
  });

  it("serves exactly 20 distinct rows and audits all 20 owners", async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...listed,
      id: String(2_000_000_000 + index),
    }));
    const deps = setup(candidates);
    const response = await memberDirectoryResponse(deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(20);
    expect(deps.writeAudit.mock.lastCall?.[0].subjectUserIds).toEqual(
      candidates.map(({ id }) => id),
    );
  });

  it("serves empty and self-only results without writing an audit row", async () => {
    const deps = setup([]);
    const empty = await memberDirectoryResponse(deps);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    deps.source.mockResolvedValueOnce([{ ...listed, id: viewerId }]);
    const self = await memberDirectoryResponse(deps);
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual([{ name: listed.name, profileHref: `/members/${viewerId}` }]);
    expect(deps.writeAudit).not.toHaveBeenCalled();
  });

  it("rejects oversized, ambiguous, and malformed source results before rendering", async () => {
    const deps = setup();
    for (const candidates of [
      Array.from({ length: DIRECTORY_ROW_LIMIT + 1 }, () => listed),
      [listed, { ...hidden, id: listed.id }],
      [{ ...listed, id: "//example.invalid" }],
      [{ ...listed, name: "x".repeat(129) }],
      [{ ...listed, name: "  " }],
    ]) {
      deps.source.mockResolvedValueOnce(candidates);
      expect((await memberDirectoryResponse(deps)).status).toBe(503);
    }
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.writeAudit).not.toHaveBeenCalled();
  });

  it("fails closed on an unavailable source or a read that exceeds its single deadline", async () => {
    vi.useFakeTimers();
    try {
      const deps = setup();
      deps.source.mockRejectedValueOnce(new Error("private-fixture-driver-detail"));
      const rejected = await memberDirectoryResponse(deps);
      expect(rejected.status).toBe(503);
      expect(await rejected.text()).toBe("Member data is temporarily unavailable.");

      let settle: ((rows: DirectoryCandidate[]) => void) | undefined;
      deps.source.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      const pending = memberDirectoryResponse(deps);
      const signal = deps.source.mock.lastCall?.[0].signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(DIRECTORY_READ_TIMEOUT_MS);
      expect((await pending).status).toBe(503);
      expect(signal?.aborted).toBe(true);
      settle?.([listed]);
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.source).toHaveBeenCalledTimes(2);
      expect(deps.render).not.toHaveBeenCalled();
      expect(deps.writeAudit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
