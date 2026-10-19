import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import {
  declareMemberResult,
  keyedMemberRead,
  MemberReadRefused,
  memberQueryPermit,
  memberReadResponse,
} from "../src/member-reads";

// Hermetic: the DB adapter's contract, reduced to its observable effects. A
// permitted read consumes exactly one query and declares the owners it
// retrieved; the real adapter (src/db/member-reads.ts) does the same from rows.
const VIEWER = "100000000000000101";
const SUBJECT = "100000000000000102";
const OTHER = "100000000000000103";
const meta = { method: "GET", route: "/members/:id" };
const reads = { resource: "profile", action: "view" as const, route: "profile" };
const declared = (viewer: string | null = VIEWER) => ({ ...reads, viewer });
const READ_REFUSAL = "Member data is temporarily unavailable.";

const readOwners = <T>(owners: string[], value: T) =>
  keyedMemberRead(async () => {
    memberQueryPermit();
    declareMemberResult(owners);
    return value;
  });

const recorder = () => {
  const entries: AccessEntry[] = [];
  const sink = vi.fn(async (entry: AccessEntry) => {
    entries.push(entry);
    return true;
  });
  return { entries, sink };
};

const outage = () =>
  Object.assign(new Error("terminating connection due to administrator command"), {
    name: "PostgresError",
    code: "57P01",
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const expectRefused = async (res: Response) => {
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.getSetCookie()).toEqual([]);
  const body = await res.text();
  expect(body).toBe(READ_REFUSAL);
  for (const marker of [VIEWER, SUBJECT, OTHER]) expect(body).not.toContain(marker);
};

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("memberReadResponse (Kit boundary)", () => {
  it.each([
    ["text/html", "<h1>profile</h1>"],
    ["application/json", { rows: [SUBJECT] }],
  ])(
    "releases a buffered %s response after the audit names the retrieved subjects",
    async (type, value) => {
      const { entries, sink } = recorder();
      const res = await memberReadResponse(meta, declared(), sink, async () => {
        const body = await readOwners([SUBJECT, VIEWER, SUBJECT], value);
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          headers: { "content-type": type },
        });
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toContain(type === "application/json" ? SUBJECT : "profile");
      expect(entries).toEqual([
        {
          viewerDiscordId: VIEWER,
          viewerUserId: VIEWER,
          resource: "profile",
          action: "view",
          route: "profile",
          subjectUserIds: [SUBJECT],
        },
      ]);
    },
  );

  it("does not release bytes before the audit write settles", async () => {
    let finishAudit!: (recorded: boolean) => void;
    const sink = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishAudit = resolve;
        }),
    );
    let released = false;
    const pending = memberReadResponse(
      meta,
      declared(),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>")),
    ).then((res) => {
      released = true;
      return res;
    });
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(released).toBe(false);
    finishAudit(true);
    expect((await pending).status).toBe(200);
  });

  it("writes no row and releases when only the viewer's own record was read", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () => new Response(await readOwners([VIEWER], "<p>me</p>")),
    );
    expect(sink).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>me</p>");
  });

  it("refuses with a sanitized 503 when the audit database is unavailable", async () => {
    const sink = vi.fn(async () => {
      throw outage();
    });
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () => new Response(await readOwners([SUBJECT], `<p>${SUBJECT}</p>`)),
    );
    await expectRefused(res);
  });

  it("refuses when the audit write fails for a non-outage reason, naming only the class", async () => {
    const sink = vi.fn(async () => {
      throw new Error(`insert failed for ${SUBJECT}`);
    });
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>")),
    );
    await expectRefused(res);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("Member read audit failed; refusing contents.");
    expect(logged).not.toContain(SUBJECT);
  });

  it("refuses when the sink reports that no row was recorded", async () => {
    const sink = vi.fn(async () => false);
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>")),
    );
    await expectRefused(res);
  });

  it("refuses an undeclared query even when the handler catches the refusal", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(meta, declared(), sink, async () => {
      let swallowed: unknown;
      try {
        memberQueryPermit();
      } catch (err) {
        swallowed = err;
      }
      expect(swallowed).toBeInstanceOf(MemberReadRefused);
      return new Response("<p>x</p>");
    });
    await expectRefused(res);
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses a second query inside one permitted read", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(meta, declared(), sink, async () => {
      await keyedMemberRead(async () => {
        memberQueryPermit();
        memberQueryPermit();
        declareMemberResult([SUBJECT]);
        return null;
      }).catch(() => undefined);
      return new Response("<p>x</p>");
    });
    await expectRefused(res);
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses when a declared read outlives the handler (pending)", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(meta, declared(), sink, async () => {
      void keyedMemberRead(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => {
              memberQueryPermit();
              declareMemberResult([SUBJECT]);
              resolve("late");
            }, 20),
          ),
      );
      return new Response("<p>early</p>");
    });
    await expectRefused(res);
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses a handler that throws, even when the thrown text names a subject", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(meta, declared(), sink, async () => {
      throw new Error(`lookup failed for ${SUBJECT}`);
    });
    await expectRefused(res);
    expect(sink).not.toHaveBeenCalled();
  });

  it("an anonymous viewer may receive subject-free output but never member contents", async () => {
    const { sink } = recorder();
    const publicOnly = await memberReadResponse(
      meta,
      declared(null),
      sink,
      async () => new Response("<p>public</p>"),
    );
    expect(publicOnly.status).toBe(200);
    expect(await publicOnly.text()).toBe("<p>public</p>");

    const leaked = await memberReadResponse(
      meta,
      declared(null),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>")),
    );
    await expectRefused(leaked);
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses a viewer identity that is not a snowflake before any audit write", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(
      meta,
      declared("viewer-1"),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>")),
    );
    await expectRefused(res);
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses when no declaration exists for the route", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(
      meta,
      () => undefined,
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>")),
    );
    await expectRefused(res);
    expect(sink).not.toHaveBeenCalled();
  });

  it("HEAD keeps the audit: the read happened even though no body leaves", async () => {
    const { entries, sink } = recorder();
    const head = { ...meta, method: "HEAD" };
    const res = await memberReadResponse(head, declared(), sink, async () => {
      await readOwners([SUBJECT], "<p>x</p>");
      return new Response(null, { headers: { "content-type": "text/html" } });
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });

  it("HEAD refuses when its audit fails", async () => {
    const sink = vi.fn(async () => {
      throw outage();
    });
    const head = { ...meta, method: "HEAD" };
    const res = await memberReadResponse(head, declared(), sink, async () => {
      await readOwners([SUBJECT], "<p>x</p>");
      return new Response(null, { headers: { "content-type": "text/html" } });
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reads a streamed body to completion inside the boundary, including deferred member reads", async () => {
    const { entries, sink } = recorder();
    // Built inside render, as Kit builds its SSR stream: a stream constructed
    // outside the boundary would pull outside the request's async context.
    const res = await memberReadResponse(meta, declared(), sink, async () => {
      const parts = [async () => "first|", () => readOwners([SUBJECT], "second")];
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = parts[index++];
          if (!part) return controller.close();
          controller.enqueue(new TextEncoder().encode(await part()));
        },
      });
      return new Response(stream);
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("first|second");
    expect(entries.map((entry) => entry.subjectUserIds)).toEqual([[SUBJECT]]);
  });

  it("a stream that fails mid-body releases none of its partial bytes", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(meta, declared(), sink, async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`PARTIAL-${SUBJECT}`));
          controller.error(new Error("stream aborted"));
        },
      });
      return new Response(stream);
    });
    await expectRefused(res);
  });

  it("a load-set shared cache policy cannot escape a member response", async () => {
    const { sink } = recorder();
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () =>
        new Response(await readOwners([SUBJECT], "<p>x</p>"), {
          headers: { "cache-control": "public, max-age=300" },
        }),
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a refused response drops cookies the rendered page tried to set", async () => {
    const sink = vi.fn(async () => {
      throw outage();
    });
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () =>
        new Response(await readOwners([SUBJECT], "<p>x</p>"), {
          headers: { "set-cookie": "__Host-leak=1; Path=/; Secure" },
        }),
    );
    await expectRefused(res);
  });

  it("a released response keeps the cookies the rendered page set", async () => {
    const { sink } = recorder();
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const res = await memberReadResponse(
      meta,
      declared(),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>x</p>"), { headers }),
    );
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it.each(["clean-first", "dirty-first"] as const)(
    "concurrent requests keep separate captures (%s): one request's pending read never refuses another",
    async (order) => {
      const { entries, sink } = recorder();
      const cleanEntered = deferred();
      const dirtyEntered = deferred();
      const cleanParked = deferred();
      const dirtyParked = deferred();
      const cleanDeclared = deferred();
      const dirtyDeclared = deferred();
      const cleanRelease = deferred();
      const dirtyRelease = deferred();
      let settleLate: Promise<string> = Promise.resolve("unstarted");
      const clean = memberReadResponse(meta, declared(VIEWER), sink, async () => {
        const body = await keyedMemberRead(async () => {
          memberQueryPermit();
          cleanEntered.resolve();
          await dirtyEntered.promise;
          cleanParked.resolve();
          await cleanRelease.promise;
          declareMemberResult([VIEWER, SUBJECT]);
          cleanDeclared.resolve();
          return "<p>clean</p>";
        });
        return new Response(body);
      });
      const dirty = memberReadResponse(meta, declared(OTHER), sink, async () => {
        settleLate = keyedMemberRead(async () => {
          memberQueryPermit();
          dirtyEntered.resolve();
          await cleanEntered.promise;
          dirtyParked.resolve();
          await dirtyRelease.promise;
          declareMemberResult([SUBJECT]);
          dirtyDeclared.resolve();
          return "late";
        });
        return new Response("<p>dirty</p>");
      });
      const both = Promise.all([clean, dirty]);
      try {
        // Rendezvous: both sensitive reads have begun and are still pending.
        await cleanEntered.promise;
        await dirtyEntered.promise;
        await cleanParked.promise;
        await dirtyParked.promise;
        // Pin the refusal while the late read is still parked. The dirty
        // render already returned, so its boundary decides here (pending read
        // -> 503) in both orders, before either read completes. Without this
        // pin, releasing the dirty gate first lets the late read land before
        // the boundary decides (200 instead of 503 on Node 22 scheduling).
        const dirtyRes = await dirty;
        let cleanRes: Response;
        if (order === "clean-first") {
          cleanRelease.resolve();
          await cleanDeclared.promise;
          // Force the clean boundary to decide while the dirty read is still
          // parked: a pending read in another capture must not refuse it.
          cleanRes = await clean;
          dirtyRelease.resolve();
          await dirtyDeclared.promise;
        } else {
          dirtyRelease.resolve();
          await dirtyDeclared.promise;
          cleanRelease.resolve();
          cleanRes = await clean;
        }
        expect(cleanRes.status).toBe(200);
        expect(await cleanRes.text()).toBe("<p>clean</p>");
        await expectRefused(dirtyRes);
        await expect(settleLate).resolves.toBe("late");
        expect(entries).toEqual([
          {
            viewerDiscordId: VIEWER,
            viewerUserId: VIEWER,
            resource: "profile",
            action: "view",
            route: "profile",
            subjectUserIds: [SUBJECT],
          },
        ]);
      } finally {
        cleanRelease.resolve();
        dirtyRelease.resolve();
        await settleLate.catch(() => "refused");
        await both.catch(() => undefined);
      }
    },
  );

  it("concurrent requests never share a viewer: each row names only its own viewer", async () => {
    const { entries, sink } = recorder();
    const one = memberReadResponse(meta, declared(VIEWER), sink, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(await readOwners([SUBJECT], "<p>1</p>"));
    });
    const two = memberReadResponse(
      meta,
      declared(OTHER),
      sink,
      async () => new Response(await readOwners([SUBJECT], "<p>2</p>")),
    );
    await Promise.all([one, two]);
    expect(entries.map((entry) => entry.viewerDiscordId).sort()).toEqual([OTHER, VIEWER].sort());
    for (const entry of entries) {
      expect(entry.subjectUserIds).toEqual([SUBJECT]);
      expect(entry.subjectUserIds).not.toContain(entry.viewerDiscordId);
    }
  });
});
