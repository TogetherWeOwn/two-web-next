import { beforeAll, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({ journeys: [] as Array<(args: unknown) => Promise<void>> }));

vi.mock("../e2e/staging/fixtures", () => {
  const journey = Object.assign(
    (_name: string, fn: (args: unknown) => Promise<void>) => harness.journeys.push(fn),
    {
      beforeAll: () => {},
      slow: () => {},
      setTimeout: () => {},
      info: () => ({ annotations: [] }),
    },
  );
  return {
    test: journey,
    expect: (actual: unknown) => ({
      toHaveURL: async () => {},
      toBeDefined: () => expect(actual).toBeDefined(),
      toMatch: (pattern: RegExp) => expect(actual).toMatch(pattern),
      toBeVisible: async () => {
        throw new Error("saved form fault");
      },
    }),
    eventFixtureWindow: () => ({ startsAt: "start", endsAt: "end", timezone: "UTC" }),
    stagingOrigin: "https://staging.example.test",
    moderatorStorageState: {},
    memberStorageState: {},
    emptyStorageState: {},
  };
});

beforeAll(async () => {
  const journeySpec = "../e2e/staging/event-rsvp.spec";
  await import(journeySpec);
});

test("a saved-form failure cancels the exact created draft key", async () => {
  const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const locator = { fill: vi.fn(), click: vi.fn() };
  const page = {
    goto: vi.fn(),
    getByRole: () => locator,
    getByLabel: () => locator,
    url: () => `https://staging.example.test/admin/events/${key}?saved=1`,
  };
  const post = vi.fn(async (_url: string, _options: unknown) => ({ status: () => 303 }));
  const moderator = { newPage: async () => page, request: { post }, close: vi.fn() };
  const member = { close: vi.fn() };
  const browser = {
    newContext: vi.fn().mockResolvedValueOnce(moderator).mockResolvedValueOnce(member),
  };

  const journey = harness.journeys[0];
  if (!journey) throw new Error("staging journey was not registered");
  await expect(journey({ browser })).rejects.toThrow("saved form fault");
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(`/admin/events/${key}/cancel`, {
    headers: { Origin: "https://staging.example.test" },
    maxRedirects: 0,
  });
});
