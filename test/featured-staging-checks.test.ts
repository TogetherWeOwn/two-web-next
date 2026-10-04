import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { expect as pollExpect } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { cleanupFeaturedFixture, homeHasHeadline } from "../e2e/staging/featured-checks";

const HEADLINE = "Staging E2E Featured fixture";
const ORIGIN = "https://staging.example.test";

function guestFixture(status: number | null, headlines: string[]) {
  const allTextContents = vi.fn().mockResolvedValue(headlines);
  const getByRole = vi.fn().mockReturnValue({ allTextContents });
  const getByTestId = vi.fn().mockReturnValue({ getByRole });
  const goto = vi.fn().mockResolvedValue(status === null ? null : { status: () => status });
  const page = {
    goto,
    getByTestId: vi.fn().mockReturnValue({ getByTestId }),
  } as unknown as Page;
  return { page, goto, allTextContents };
}

function cleanupFixture(status: number) {
  const post = vi.fn().mockResolvedValue({ status: () => status });
  const request = { post } as unknown as APIRequestContext;
  const testInfo: Pick<TestInfo, "annotations"> = { annotations: [] };
  return { post, request, testInfo };
}

describe("featured homepage snapshots", () => {
  it.each([
    { headlines: [HEADLINE], present: true, expected: true },
    { headlines: [HEADLINE], present: false, expected: false },
    { headlines: [], present: true, expected: false },
    { headlines: [], present: false, expected: true },
    { headlines: ["Another slot"], present: true, expected: false },
    { headlines: ["Another slot"], present: false, expected: true },
  ])(
    "matches presence=$present only against HTTP 200: $headlines",
    async ({ headlines, present, expected }) => {
      const { page, goto } = guestFixture(200, headlines);
      expect(await homeHasHeadline(page, HEADLINE, present)).toBe(expected);
      expect(goto).toHaveBeenCalledWith("/", { waitUntil: "domcontentloaded", timeout: 5_000 });
    },
  );

  it.each([null, 204, 404, 503])(
    "rejects status %s for both presence and absence",
    async (status) => {
      const { page, allTextContents } = guestFixture(status, []);
      expect(await homeHasHeadline(page, HEADLINE, true)).toBe(false);
      expect(await homeHasHeadline(page, HEADLINE, false)).toBe(false);
      expect(allTextContents).not.toHaveBeenCalled();
    },
  );

  it("rejects a transport failure for both presence and absence", async () => {
    const { page, goto } = guestFixture(200, []);
    goto.mockRejectedValue(new Error("navigation failed"));
    expect(await homeHasHeadline(page, HEADLINE, true)).toBe(false);
    expect(await homeHasHeadline(page, HEADLINE, false)).toBe(false);
  });

  it("rejects an unreadable HTTP 200 snapshot for both presence and absence", async () => {
    const { page, allTextContents } = guestFixture(200, []);
    allTextContents.mockRejectedValue(new Error("context closed"));
    expect(await homeHasHeadline(page, HEADLINE, true)).toBe(false);
    expect(await homeHasHeadline(page, HEADLINE, false)).toBe(false);
  });

  it.each([true, false])(
    "bounded polling retries failures before presence=%s succeeds",
    async (present) => {
      const { page, goto } = guestFixture(200, present ? [HEADLINE] : []);
      goto
        .mockRejectedValueOnce(new Error("navigation failed"))
        .mockResolvedValueOnce({ status: () => 503 });
      await pollExpect
        .poll(() => homeHasHeadline(page, HEADLINE, present), { timeout: 1_000, intervals: [1, 1] })
        .toBe(true);
      expect(goto).toHaveBeenCalledTimes(3);
    },
  );

  it("bounded absence polling fails when every load is an error page", async () => {
    const { page } = guestFixture(503, []);
    await expect(
      pollExpect
        .poll(() => homeHasHeadline(page, HEADLINE, false), { timeout: 50, intervals: [1] })
        .toBe(true),
    ).rejects.toThrow();
  });
});

describe("featured cleanup annotations", () => {
  it.each([303, 404])("accepts status %s without annotating", async (status) => {
    const { request, post, testInfo } = cleanupFixture(status);
    await cleanupFeaturedFixture(request, "42", ORIGIN, testInfo);
    expect(testInfo.annotations).toEqual([]);
    expect(post).toHaveBeenCalledWith("/admin/featured/42/delete", {
      headers: { Origin: ORIGIN },
      maxRedirects: 0,
      timeout: 5_000,
    });
  });

  it.each([200, 302, 403, 500])(
    "annotates unsuccessful status %s with only fixture id and status",
    async (status) => {
      const { request, testInfo } = cleanupFixture(status);
      await cleanupFeaturedFixture(request, "42", ORIGIN, testInfo);
      expect(testInfo.annotations).toEqual([
        { type: "featured-cleanup-failed", description: JSON.stringify({ id: "42", status }) },
      ]);
    },
  );

  it("reduces a transport error to -1 without replacing the original assertion failure", async () => {
    const { request, post, testInfo } = cleanupFixture(303);
    post.mockRejectedValue(
      new Error("request failed; Cookie: fixture-session=redacted-test-value"),
    );
    const originalFailure = new Error("original lifecycle assertion failed");
    const journey = async () => {
      try {
        throw originalFailure;
      } finally {
        await cleanupFeaturedFixture(request, "42", ORIGIN, testInfo);
      }
    };
    await expect(journey()).rejects.toBe(originalFailure);
    expect(testInfo.annotations).toEqual([
      { type: "featured-cleanup-failed", description: '{"id":"42","status":-1}' },
    ]);
  });
});
