// Acceptance: a code bug (plain TypeError) inside a Kit public/member load
// must never look like a downstream outage. The load path either emits an
// `error.alert` diagnostic (critical JSON on console.error, class only) or
// answers a non-503 5xx — it must not silently become a branded 503, and an
// unbranded raw throw with no diagnostic does not count either.
//
// Preservation in the same run: genuine downstream outages still answer a
// branded 503 with `private, no-store`, branded 400s still answer 400 before
// any read, and the existing member-read audit failure already emits
// `error.alert` (negative control proving the diagnostic pipeline works).
//
// Fail-first on the pre-fix code: the three "not silent" tests and the
// members-board outage-branding test are red; the rest are already green and
// must stay green. Test files only — the paired build changes the load paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { emptyGrid } from "../src/hotzones/aggregates";
import { loadHotzoneSignalData, loadHotzonesIndexData } from "../src/kit-hotzones";
import { loadMembersBoardData } from "../src/kit-members";
import {
  declareMemberResult,
  keyedMemberRead,
  memberQueryPermit,
  memberReadResponse,
} from "../src/member-reads";

const MARKER = "acceptance-probe-secret-marker";
const env = { APP_URL: "https://example.test" } as never;
const headers = () => vi.fn((_headers: Record<string, string>) => {});
const memberSession = { status: "authenticated" as const, userId: "u-viewer", member: true };
const grid = () => ({ cells: emptyGrid(), total: 3, eventCount: 2 });

const codeBug = () => new TypeError(`${MARKER}: cannot read properties of undefined`);
const outage = () => new Error("connect ECONNREFUSED");

function alertLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.includes('"error.alert"'));
}

type Outcome = { threw: boolean; status?: unknown };

async function capture(promise: Promise<unknown>): Promise<Outcome> {
  try {
    await promise;
    return { threw: false };
  } catch (error) {
    return { threw: true, status: (error as { status?: unknown })?.status };
  }
}

// The core contract: the load failed loudly. Either at least one well-formed,
// leak-free `error.alert` diagnostic was emitted, or the rejection carries a
// 5xx status that is not the silent outage 503. A resolved load, a branded
// 503 with no diagnostic, and a raw throw with no diagnostic all fail here.
function expectNotSilent(outcome: Outcome) {
  expect(outcome.threw, "a throwing load read must not resolve as a successful board").toBe(true);
  const lines = alertLines();
  for (const line of lines) {
    const parsed = JSON.parse(line) as { event?: unknown; level?: unknown };
    expect(parsed.event).toBe("error.alert");
    expect(parsed.level).toBe("critical");
    expect(line).not.toContain(MARKER);
  }
  const status = outcome.status;
  const isServerErrorNot503 =
    typeof status === "number" && status >= 500 && status <= 599 && status !== 503;
  expect(
    lines.length > 0 || isServerErrorNot503,
    `expected an error.alert or a non-503 5xx, got status=${String(status)} alerts=${lines.length}`,
  ).toBe(true);
}

function membersArgs(overrides: Record<string, unknown> = {}) {
  return {
    env,
    session: memberSession,
    seasonParam: null,
    scopeParam: null,
    activityParam: null,
    setHeaders: headers(),
    dbForFn: async () => ({}) as never,
    loadRankingFn: async () => [{ userId: "u-a", username: "Ana", count: 5 }],
    queueBoardViewFn: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  __resetAlertRateLimitForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Kit public-load failures alert instead of silent 503s (acceptance)", () => {
  it("members board: a TypeError from loadRankingFn is not silent", async () => {
    const outcome = await capture(
      loadMembersBoardData(
        membersArgs({
          loadRankingFn: async () => {
            throw codeBug();
          },
        }),
      ),
    );
    expectNotSilent(outcome);
  });

  it("hotzones index: a TypeError from loadJoinsGridFn is not silent", async () => {
    const setHeaders = headers();
    const outcome = await capture(
      loadHotzonesIndexData({
        env,
        seasonParam: null,
        setHeaders,
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw codeBug();
        },
        recordBoardViewFn: async () => {},
      }),
    );
    expectNotSilent(outcome);
    // A failed board must never be marked publicly cacheable.
    for (const call of setHeaders.mock.calls) {
      expect(call[0]["cache-control"] ?? "").not.toContain("public");
    }
  });

  it("hotzones signal: a TypeError from loadJoinsGridFn is not silent", async () => {
    const outcome = await capture(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "joins",
        setHeaders: headers(),
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw codeBug();
        },
        recordBoardViewFn: async () => {},
      }),
    );
    expectNotSilent(outcome);
  });

  it("members board: a downstream outage from loadRankingFn answers a branded 503", async () => {
    await expect(
      loadMembersBoardData(
        membersArgs({
          loadRankingFn: async () => {
            throw outage();
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("hotzones index: a downstream outage still answers 503 with private, no-store", async () => {
    const setHeaders = headers();
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: null,
        setHeaders,
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw outage();
        },
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("hotzones signal: a downstream outage still answers 503 with private, no-store", async () => {
    const setHeaders = headers();
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "joins",
        setHeaders,
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw outage();
        },
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("hotzones: a bad season still answers a branded 400 before any read, with no alert", async () => {
    const dbForFn = vi.fn(async () => null);
    const loadJoinsGridFn = vi.fn(async () => grid());
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: "not-a-season",
        setHeaders: headers(),
        dbForFn,
        loadJoinsGridFn,
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: "not-a-season",
        signalParam: "joins",
        setHeaders: headers(),
        dbForFn,
        loadJoinsGridFn,
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbForFn).not.toHaveBeenCalled();
    expect(loadJoinsGridFn).not.toHaveBeenCalled();
    expect(alertLines()).toEqual([]);
  });

  it("members board: a bad season still answers a branded 400 before any read, with no alert", async () => {
    const loadRankingFn = vi.fn(async () => []);
    await expect(
      loadMembersBoardData(membersArgs({ seasonParam: "bogus", loadRankingFn })),
    ).rejects.toMatchObject({ status: 400 });
    expect(loadRankingFn).not.toHaveBeenCalled();
    expect(alertLines()).toEqual([]);
  });

  it("negative control: a member-read audit failure already emits error.alert on this stack", async () => {
    const VIEWER = "100000000000000101";
    const SUBJECT = "100000000000000102";
    const sink = vi.fn(async () => {
      throw new Error(`${MARKER}: insert failed for ${SUBJECT}`);
    });
    const res = await memberReadResponse(
      { method: "GET", route: "/members/:id" },
      { resource: "profile", action: "view" as const, route: "profile", viewer: VIEWER },
      sink,
      async () =>
        new Response(
          await keyedMemberRead(async () => {
            memberQueryPermit();
            declareMemberResult([SUBJECT]);
            return `<p>${SUBJECT}</p>`;
          }),
        ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).not.toContain(SUBJECT);
    expect(body).not.toContain(MARKER);

    const lines = alertLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { event?: unknown; fingerprint?: unknown };
      expect(parsed.event).toBe("error.alert");
      expect(String(parsed.fingerprint)).toContain("/members/:id");
      expect(line).not.toContain(SUBJECT);
      expect(line).not.toContain(VIEWER);
      expect(line).not.toContain(MARKER);
    }
  });
});
