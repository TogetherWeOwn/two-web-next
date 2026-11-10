import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  eventSaveBaseline,
  featuredSaveBaseline,
  StaleSaveError,
} from "../src/admin/save-baseline";
import {
  duplicateEvent,
  getEvent,
  getFeatured,
  transitionEvent,
  updateEvent,
  updateFeatured,
} from "../src/admin/store";
import { ValidationError } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { eventRow, featuredRow, key } from "./helpers/admin-validation-correction";

vi.mock("../src/admin/store", async (original) => ({
  ...(await original<typeof import("../src/admin/store")>()),
  duplicateEvent: vi.fn(),
  getEvent: vi.fn(),
  transitionEvent: vi.fn(),
  getFeatured: vi.fn(),
  updateEvent: vi.fn(),
  updateFeatured: vi.fn(),
}));

const dbTouched = vi.fn(() => {
  throw new Error("refused-save fixture must not query SQL");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  execute: dbTouched,
} as unknown as Db;
const fold = {
  ...eventRow,
  timezone: "Europe/London",
  startsAt: new Date("2026-10-25T00:30:00Z"),
  endsAt: new Date("2026-10-25T01:30:00Z"),
};
function expectHistoryBeforeDeparture(html: string) {
  expect(html.match(/src="\/islands\/admin-save-baseline.js"/g)).toHaveLength(1);
  expect(html.indexOf('src="/islands/admin-save-baseline.js"')).toBeLessThan(
    html.indexOf('src="/islands/admin-event-editor.js"'),
  );
}

const values = {
  title: "Retained title",
  timezone: "Europe/London",
  starts_at: "2026-10-25 01:30",
  ends_at: "2026-10-25 01:30",
};

async function post(path: string, fields: Record<string, string>) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, MODERATOR);
  const app = new Hono()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: sessions, db }));
  return app.request(
    `${env.APP_URL}/admin${path}`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: env.APP_URL,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    },
    { ...env, ADMIN_DB: db },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEvent).mockResolvedValue(fold);
  vi.mocked(getFeatured).mockResolvedValue({
    ...featuredRow,
    startsAtText: null,
    endsAtText: null,
  });
});

describe("refused moderator save documents", () => {
  it.each(["early", "locked"])(
    "does not falsely reject a fold-spanning schedule on the %s stale path",
    async (path) => {
      const baseline = await eventSaveBaseline(
        path === "early" ? { ...fold, title: "Older saved title" } : fold,
      );
      vi.mocked(updateEvent).mockRejectedValue(new StaleSaveError({ ...fold, title: "Winner" }));
      const res = await post(`/events/${key}`, { ...values, saved_baseline: baseline });
      expect(res.status).toBe(409);
      const html = await res.text();
      expect(html).toContain('data-testid="stale-save"');
      expect(html).toContain('value="Retained title"');
      expect(html).toContain('data-event-draft=""');
      expect(html).toContain('src="/islands/admin-event-editor.js"');
      expect(html).toContain(`name="saved_baseline" value="${baseline}"`);
      expect(html).not.toContain("The end is after the start.");
      expect(html).not.toContain('data-testid="error-ends_at"');
      expect(html).toContain('src="/islands/auth-status.js"');
      expect(html.match(/data-testid="auth-tab-sync"/g)).toHaveLength(1);
      expectHistoryBeforeDeparture(html);
      expect(updateEvent).toHaveBeenCalledTimes(path === "early" ? 0 : 1);
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it("retains non-schedule and missing-date diagnostics within the single stale notice", async () => {
    const res = await post(`/events/${key}`, {
      ...values,
      title: "",
      starts_at: "",
      saved_baseline: "a".repeat(64),
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('data-testid="error-title"');
    expect(html).toContain('data-testid="error-starts_at"');
    expect(html.match(/data-admin-validation-summary/g)).toHaveLength(1);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("still rejects an invalid ordering on a current draft as 422", async () => {
    const res = await post(`/events/${key}`, {
      ...values,
      starts_at: "2026-10-26 02:00",
      ends_at: "2026-10-26 01:00",
      saved_baseline: await eventSaveBaseline(fold),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("The end is after the start.");
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", "/duplicate", "title"],
    ["publish", "/publish", "location"],
  ])(
    "re-renders the %s refusal editor with the current saved_baseline and a mounted draft marker",
    async (action, suffix, field) => {
      const refusal = new ValidationError({ [field]: "Fix this field." });
      if (action === "duplicate") vi.mocked(duplicateEvent).mockRejectedValue(refusal);
      else vi.mocked(transitionEvent).mockRejectedValue(refusal);
      const res = await post(`/events/${key}${suffix}`, {});
      expect(res.status).toBe(422);
      const html = await res.text();
      const baseline = html.match(/name="saved_baseline" value="([0-9a-f]{64})"/)?.[1];
      expect(baseline).toBe(await eventSaveBaseline(fold));
      expect(html).toContain('data-event-draft=""');
      expect(html).toContain(`data-testid="error-${field}"`);
      expect(updateEvent).not.toHaveBeenCalled();
      vi.mocked(updateEvent).mockResolvedValue({ row: fold, writeBack: null, childWriteBacks: [] });
      const corrected = await post(`/events/${key}`, {
        ...values,
        location: "Community voice room",
        saved_baseline: baseline!,
      });
      expect(corrected.status).toBe(303);
      expect(updateEvent).toHaveBeenCalledExactlyOnceWith(
        db,
        expect.objectContaining({ id: MODERATOR.userId }),
        key,
        expect.objectContaining({ title: values.title, location: "Community voice room" }),
        baseline,
      );
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );

  it.each([400, 409])(
    "mounts expiry recovery exactly once on a featured %s draft",
    async (status) => {
      const baseline =
        status === 400
          ? ""
          : await featuredSaveBaseline({
              ...featuredRow,
              title: "Older",
              startsAtText: null,
              endsAtText: null,
            });
      const res = await post(`/featured/${featuredRow.id}`, {
        title: "My draft",
        saved_baseline: baseline,
      });
      expect(res.status).toBe(status);
      const html = await res.text();
      expect(html).toContain('data-event-draft=""');
      expect(html).toContain('src="/islands/admin-event-editor.js"');
      expect(html).toContain('src="/islands/auth-status.js"');
      expect(html.match(/data-testid="auth-tab-sync"/g)).toHaveLength(1);
      expectHistoryBeforeDeparture(html);
      expect(updateFeatured).not.toHaveBeenCalled();
      expect(dbTouched).not.toHaveBeenCalled();
    },
  );
});
