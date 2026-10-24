// Malformed native URL state renders no Retry loading link: a non-string
// pathname or search on an otherwise native page.url keeps only the fixed
// exits in both admin boundaries. The URL-level rejection lives in
// test/admin-read-retry-url.test.ts; this suite pins the rendered outcome.
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_RETRY_ORIGIN,
  type AdminBoundary,
  type AdminRetryKit,
  anchors,
  compileAdminRetryKit,
  retryAnchors,
} from "./helpers/admin-read-retry-acceptance";

let kit: AdminRetryKit;
beforeAll(async () => {
  kit = await compileAdminRetryKit();
});

const boundaries: AdminBoundary[] = ["admin", "join-attempts"];

function pathnameFor(boundary: AdminBoundary): string {
  return boundary === "admin" ? "/admin/events" : "/admin/join-attempts";
}

describe("malformed native URL state keeps only the fixed exits", () => {
  it.each(boundaries)("%s renders no retry for a boxed-string search", async (boundary) => {
    const pathname = pathnameFor(boundary);
    const url = new URL(`${pathname}?page=2`, ADMIN_RETRY_ORIGIN);
    Object.defineProperty(url, "search", { value: new String("?page=2") });
    const { body } = kit.render(boundary, {
      status: 503,
      url,
      route: { id: pathname },
      params: {},
    });
    expect(await retryAnchors(body)).toHaveLength(0);
    expect((await anchors(body)).map((anchor) => anchor.href)).toContain("/admin");
  });

  it.each(boundaries)("%s renders no retry for a string-coercible pathname", async (boundary) => {
    const pathname = pathnameFor(boundary);
    const url = new URL(`${pathname}?page=2`, ADMIN_RETRY_ORIGIN);
    Object.defineProperty(url, "pathname", { value: { toString: () => pathname } });
    const { body } = kit.render(boundary, {
      status: 503,
      url,
      route: { id: pathname },
      params: {},
    });
    expect(await retryAnchors(body)).toHaveLength(0);
    expect((await anchors(body)).map((anchor) => anchor.href)).toContain("/admin");
  });
});
