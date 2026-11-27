import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchKitQueuePreview } from "../src/admin/kit-queue-preview";
import {
  queuePreviewAdmission,
  queuePreviewHandler,
  respondQueuePreview,
} from "../src/admin/queue-preview";
import { buildAdminApp } from "../src/admin/routes";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";

vi.mock(import("../src/admin/queue-preview"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    queuePreviewAdmission: vi.fn(actual.queuePreviewAdmission),
    respondQueuePreview: vi.fn(actual.respondQueuePreview),
  };
});

const path = "/admin/queue/failed/42/preview";
const requestId = "0123456789abcdef";
const bindings = {
  ...env,
  APP_URL: STAGING_APP_URL,
  QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
  QUEUE_RECONCILE_OPERATOR_ID: MODERATOR.userId,
};

describe("native queue preview middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("matches the admission, guard and handler order registered in admin routes", async () => {
    const guard = vi.fn();
    const [matched] = buildAdminApp(guard).router.match("GET", path.slice("/admin".length));
    expect(matched.map(([[handler]]) => handler)).toEqual([
      queuePreviewAdmission,
      guard,
      queuePreviewHandler,
    ]);

    const store = createMemorySessionStore();
    const sessionBindings = { ...bindings, SESSION_STORE: store };
    const cookie = await cookieFor(store, MODERATOR);
    const readSession = vi.spyOn(store, "get");
    const respond = vi
      .mocked(respondQueuePreview)
      .mockRejectedValueOnce(new Error("handler failed"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetchKitQueuePreview(
      new Request(`${STAGING_APP_URL}${path}`, { headers: { origin: STAGING_APP_URL, cookie } }),
      sessionBindings,
      "42",
      requestId,
    );

    expect(queuePreviewAdmission).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
    expect(queuePreviewAdmission).toHaveBeenCalledBefore(readSession);
    expect(readSession).toHaveBeenCalledBefore(respond);
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('"route":"/admin/queue/failed/:id/preview"'),
    );
  });

  it("replaces a finalized response with the moderator refusal", async () => {
    vi.mocked(queuePreviewAdmission).mockImplementationOnce(async (c, next) => {
      c.res = c.json({ previewOnly: true });
      await next();
    });
    const response = await fetchKitQueuePreview(
      new Request(`${STAGING_APP_URL}${path}`, { headers: { origin: STAGING_APP_URL } }),
      bindings,
      "42",
      requestId,
    );

    expect(respondQueuePreview).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(await response.text()).toBe("");
  });
});
