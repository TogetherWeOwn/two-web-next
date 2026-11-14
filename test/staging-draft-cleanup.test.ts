import { beforeAll, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  journeys: [] as Array<(args: unknown) => Promise<void>>,
  fault: "",
  annotations: [] as Array<{ type: string; description: string }>,
}));

vi.mock("../e2e/staging/fixtures", () => {
  const journey = Object.assign(
    (_name: string, fn: (args: unknown) => Promise<void>) => harness.journeys.push(fn),
    {
      beforeAll: () => {},
      slow: () => {},
      setTimeout: () => {},
      info: () => ({ annotations: harness.annotations }),
    },
  );
  const check = (boundary: string) => {
    if (harness.fault === boundary) throw new Error(`saved form fault: ${boundary}`);
  };
  return {
    test: journey,
    expect: (actual: unknown) => ({
      toHaveURL: async (pattern: RegExp) =>
        expect((actual as { url: () => string }).url()).toMatch(pattern),
      toBeDefined: () => expect(actual).toBeDefined(),
      toMatch: (pattern: RegExp) => expect(actual).toMatch(pattern),
      toBeVisible: async () => check((actual as { boundary: string }).boundary),
      toHaveValue: async () => check((actual as { boundary: string }).boundary),
      toContainText: async () => check((actual as { boundary: string }).boundary),
      toHaveAttribute: async () => check(`${(actual as { boundary: string }).boundary}-href`),
    }),
    eventFixtureWindow: () => ({ startsAt: "start", endsAt: "end", timezone: "UTC" }),
    stagingOrigin: "https://staging.example.test",
    moderatorStorageState: {},
    memberStorageState: {},
    emptyStorageState: {},
  };
});

beforeAll(async () => {
  await import("../e2e/staging/event-rsvp.spec");
});

const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function fixture(url = `https://staging.example.test/admin/events/${key}?saved=1`) {
  const locator = (boundary: string) => ({
    boundary,
    fill: vi.fn(),
    click: vi.fn(),
    getByRole: () => locator("review-visible"),
  });
  const page = {
    goto: vi.fn(),
    getByRole: (role: string) => locator(role === "heading" ? "heading" : role),
    getByLabel: (label: string) => locator(label),
    getByTestId: () => locator("saved-text"),
    url: () => url,
  };
  const post = vi.fn(async (_url: string, _options: unknown) => ({ status: () => 303 }));
  const moderator = { newPage: async () => page, request: { post }, close: vi.fn() };
  const member = { close: vi.fn() };
  const browser = {
    newContext: vi.fn().mockResolvedValueOnce(moderator).mockResolvedValueOnce(member),
  };
  const journey = harness.journeys[0];
  if (!journey) throw new Error("staging journey was not registered");
  harness.annotations.length = 0;
  return { journey, browser, post, moderator, member };
}

test.each([
  "heading",
  "Starts (local wall time, YYYY-MM-DD HH:mm)",
  "Ends (local wall time, YYYY-MM-DD HH:mm)",
  "Timezone",
  "saved-text",
  "review-visible",
  "review-visible-href",
])("a saved-form failure at %s cancels the exact created draft key", async (boundary) => {
  harness.fault = boundary;
  const { journey, browser, post, moderator, member } = fixture();
  await expect(journey({ browser })).rejects.toThrow(`saved form fault: ${boundary}`);
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(`/admin/events/${key}/cancel`, {
    headers: { Origin: "https://staging.example.test" },
    maxRedirects: 0,
  });
  expect(moderator.close).toHaveBeenCalledOnce();
  expect(member.close).toHaveBeenCalledOnce();
});

test.each([
  "https://staging.example.test/admin/events/?saved=1",
  "https://staging.example.test/admin/events/not-a-key?saved=1",
])("an unavailable or malformed key is never guessed from %s", async (url) => {
  harness.fault = "";
  const { journey, browser, post, moderator, member } = fixture(url);
  await expect(journey({ browser })).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
  expect(moderator.close).toHaveBeenCalledOnce();
  expect(member.close).toHaveBeenCalledOnce();
});

test("cleanup failure preserves the journey error and closes both contexts", async () => {
  harness.fault = "heading";
  const { journey, browser, post, moderator, member } = fixture();
  post.mockRejectedValueOnce(new Error("cancel unavailable"));
  await expect(journey({ browser })).rejects.toThrow("saved form fault: heading");
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(`/admin/events/${key}/cancel`, {
    headers: { Origin: "https://staging.example.test" },
    maxRedirects: 0,
  });
  expect(harness.annotations).toContainEqual({
    type: "fixture-cleanup",
    description: "cancel request failed; global teardown sweeps the fixture",
  });
  expect(moderator.close).toHaveBeenCalledOnce();
  expect(member.close).toHaveBeenCalledOnce();
});
