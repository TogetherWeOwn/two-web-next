import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone probe tooling has no declaration file.
// biome-ignore format: single-line import keeps the @ts-expect-error above attached to TS7016 (wrapping detaches it)
import { PREVIEW_PATH, QA_HEADER, REDISPATCH_PATH, SOURCE_EVIDENCE_PATH, STAGING_URL, runProbe, sessionCookieValue } from "../bin/queue-authwall-probe.mjs";

function headers(init: Record<string, string>, cookies: string[] = []): Headers {
  const h = new Headers(init);
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

function response(status: number, init: Record<string, string> = {}, cookies: string[] = []) {
  return new Response(null, { status, headers: headers(init, cookies) });
}

const cookieFor = (session: string) =>
  `__Host-two_session=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const MEMBER_SESSION = cookieFor("fixture-member-session");
const MODERATOR_SESSION = cookieFor("fixture-moderator-session");

type Admission = { preview: boolean; redispatch: boolean; evidence: boolean };
const ALL_ENABLED: Admission = { preview: true, redispatch: true, evidence: true };
const ALL_DISABLED: Admission = { preview: false, redispatch: false, evidence: false };

/** Fixture transport: each route walled when its flag is on, DB-free 404 when off. */
function greenFetch(admission: Admission = ALL_ENABLED) {
  return vi.fn(
    async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const origin = init?.headers?.origin ?? init?.headers?.Origin;
      const cookie = init?.headers?.Cookie ?? init?.headers?.cookie ?? "";
      const presented = init?.headers?.[QA_HEADER] ?? "";
      const bearer = init?.headers?.authorization ?? init?.headers?.Authorization ?? "";
      if (path.startsWith("/auth/qa/")) {
        if (presented !== "fixture-qa-token") return response(404);
        // Identity-distinct sessions, like the real seam's per-identity rows.
        return response(204, {}, [
          path.endsWith("qa-moderator") ? MODERATOR_SESSION : MEMBER_SESSION,
        ]);
      }
      // The global same-origin guard runs before every queue admission.
      if (method === "POST" && origin !== STAGING_URL) return response(403);
      if (path === PREVIEW_PATH) {
        if (!admission.preview) return response(404);
        if (method !== "GET") return response(405, { allow: "GET" });
        if (origin !== STAGING_URL) return response(403);
        if (!cookie) return response(302, { location: "/auth/discord" });
        return response(403);
      }
      if (path === REDISPATCH_PATH) {
        if (!admission.redispatch) return response(404);
        if (method !== "POST") return response(405, { allow: "POST" });
        if (!cookie)
          return response(303, { location: `/auth/recover?next=${encodeURIComponent(path)}` });
        return response(403);
      }
      if (path === SOURCE_EVIDENCE_PATH) {
        // Write verbs refuse before any flag, session or source read.
        if (method !== "GET") return response(405, { allow: "GET" });
        if (!admission.evidence) return response(404);
        // Session-free by construction: only the runtime bearer admits, and
        // the probe owns no bearer.
        if (!bearer) return response(403);
        return response(403);
      }
      return response(404);
    },
  );
}

// 3 guest legs + member login + 3 member legs + moderator login +
// 3 moderator legs + cross-origin control + method control.
const EXPECTED_SENDS = 13;
// 6 preview + 6 redispatch + 3 source-evidence + 2 controls + 1 agreement.
const EXPECTED_CHECKS = 18;

describe("queue auth-wall probe tool (local fixtures)", () => {
  it("covers one canonical selector per operator route", () => {
    expect(PREVIEW_PATH).toBe("/admin/queue/failed/7/preview");
    expect(REDISPATCH_PATH).toBe("/admin/queue/failed/7/redispatch");
    expect(SOURCE_EVIDENCE_PATH).toBe("/admin/queue/source-evidence/7");
  });

  it("reads the session cookie value and ignores other cookies", () => {
    const res = response(204, {}, ["other=1; Path=/", MEMBER_SESSION]);
    expect(sessionCookieValue(res)).toBe("__Host-two_session=fixture-member-session");
    expect(sessionCookieValue(response(204))).toBeNull();
  });

  it("passes the default-off drill: every leg 404s, no wall expected", async () => {
    const send = greenFetch(ALL_DISABLED);
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBe(0);
    expect(result).toMatchObject({
      target: STAGING_URL,
      admission: { preview: "disabled", redispatch: "disabled", sourceEvidence: "disabled" },
      hits: { qaLogin: 2, preview: 3, redispatch: 4, sourceEvidence: 4 },
    });
    expect(result.passed).toBe(EXPECTED_CHECKS);
    expect(send).toHaveBeenCalledTimes(EXPECTED_SENDS);
  });

  it("passes the walled drill: guest bounces, member/moderator hold 403", async () => {
    const send = greenFetch(ALL_ENABLED);
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBe(0);
    expect(result).toMatchObject({
      target: STAGING_URL,
      admission: { preview: "enabled", redispatch: "enabled", sourceEvidence: "enabled" },
      legs: {
        guest: "oauth / recovery / bearer wall, or disabled 404",
        member: "403 wall, or disabled 404",
        moderator: "403 operator wall, or disabled 404",
      },
    });
    expect(result.passed).toBe(EXPECTED_CHECKS);
    expect(send).toHaveBeenCalledTimes(EXPECTED_SENDS);
    // Two QA logins presented the token in a header, never in a URL or body.
    const logins = send.mock.calls.filter(([url]) =>
      new URL(url as string).pathname.startsWith("/auth/qa/"),
    );
    expect(logins).toHaveLength(2);
    for (const [, init] of logins) {
      const h = (init as { headers: Record<string, string> }).headers;
      expect(h[QA_HEADER]).toBe("fixture-qa-token");
    }
    expect(JSON.stringify(result)).not.toContain("fixture-qa-token");
    // The probe sends sessions as Cookie headers but never logs them back.
    expect(JSON.stringify(result)).not.toContain("fixture-member-session");
    expect(JSON.stringify(result)).not.toContain("fixture-moderator-session");
    // No login request carried a Cookie header: the seam authenticates by header.
    for (const [, init] of logins) {
      expect((init as { headers: Record<string, string> }).headers.Cookie).toBeUndefined();
    }
    // The probe owns no evidence bearer and sends none.
    for (const [url, init] of send.mock.calls) {
      if (new URL(url as string).pathname !== SOURCE_EVIDENCE_PATH) continue;
      const h = (init as { headers: Record<string, string> }).headers;
      expect(h.authorization).toBeUndefined();
      expect(h.Authorization).toBeUndefined();
    }
  });

  it.each([
    { name: "evidence-only activation", admission: { ...ALL_DISABLED, evidence: true } },
    {
      name: "preview/redispatch activation without evidence",
      admission: { ...ALL_ENABLED, evidence: false },
    },
  ])("passes independent source-evidence activation: $name", async ({ admission }) => {
    const send = greenFetch(admission);
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBe(0);
    expect(result.admission).toEqual({
      preview: admission.preview ? "enabled" : "disabled",
      redispatch: admission.redispatch ? "enabled" : "disabled",
      sourceEvidence: admission.evidence ? "enabled" : "disabled",
    });
  });

  it("fails when preview and redispatch disagree on their shared flag", async () => {
    const send = greenFetch({ ...ALL_ENABLED, redispatch: false });
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "preview/redispatch admission agreement",
    );
    expect(result.admission).toMatchObject({ preview: "enabled", redispatch: "disabled" });
  });

  it("fails when a member preview leaks advice instead of 403ing", async () => {
    const send = greenFetch(ALL_ENABLED);
    const inner = send.getMockImplementation()!;
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        const h = init?.headers ?? {};
        if (
          new URL(url).pathname === PREVIEW_PATH &&
          (init?.method ?? "GET") === "GET" &&
          (h.Cookie ?? h.cookie ?? "").includes("member")
        )
          return response(200);
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "member GET preview status",
    );
  });

  it("fails when a moderator redispatch writes instead of 403ing", async () => {
    const send = greenFetch(ALL_ENABLED);
    const inner = send.getMockImplementation()!;
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        const h = init?.headers ?? {};
        if (
          new URL(url).pathname === REDISPATCH_PATH &&
          init?.method === "POST" &&
          (h.Cookie ?? h.cookie ?? "").includes("moderator")
        )
          return response(200);
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "moderator POST redispatch status",
    );
  });

  it("fails when a guest evidence read answers instead of 403ing", async () => {
    const send = greenFetch(ALL_ENABLED);
    const inner = send.getMockImplementation()!;
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        if (
          new URL(url).pathname === SOURCE_EVIDENCE_PATH &&
          (init?.method ?? "GET") === "GET" &&
          !(init?.headers?.Cookie ?? init?.headers?.cookie)
        )
          return response(200);
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "guest GET source-evidence status",
    );
    expect(result.admission).toMatchObject({ sourceEvidence: "unexpected" });
  });

  it("fails closed on an unexpected guest state and redacts the raw target", async () => {
    const send = greenFetch(ALL_ENABLED);
    const inner = send.getMockImplementation()!;
    const evil = "https://evil.example/provider-secret-9f27";
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        if (new URL(url).pathname === PREVIEW_PATH && !(init?.headers?.Cookie ?? "")) {
          return response(302, { location: evil });
        }
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "guest GET preview location",
    );
    // The provider-controlled target never escapes into the printed report.
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(JSON.stringify(result)).not.toContain("provider-secret-9f27");
  });

  it("fails when the cross-origin control bounces instead of 403ing", async () => {
    const send = greenFetch(ALL_ENABLED);
    const inner = send.getMockImplementation()!;
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        if ((init?.headers?.origin ?? "") === "https://evil.example")
          return response(303, { location: "/auth/recover?next=/admin" });
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "guest POST without trusted origin status",
    );
  });

  it("fails when the evidence method control answers instead of 405ing", async () => {
    const send = greenFetch(ALL_DISABLED);
    const inner = send.getMockImplementation()!;
    send.mockImplementation(
      async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        if (new URL(url).pathname === SOURCE_EVIDENCE_PATH && init?.method === "POST")
          return response(200);
        return inner(url, init);
      },
    );
    const result = await runProbe({ token: "fixture-qa-token", fetch: send });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.map((f: { label: string }) => f.label)).toContain(
      "guest POST source-evidence status",
    );
  });

  it("posts every mutation write with an empty body and the deliberate origins only", async () => {
    const send = greenFetch(ALL_ENABLED);
    await runProbe({ token: "fixture-qa-token", fetch: send });
    const posts = send.mock.calls.filter(
      ([, init]) => (init as { method?: string }).method === "POST",
    );
    // 2 logins + guest/member/moderator redispatch + 2 controls.
    expect(posts).toHaveLength(7);
    const writes = posts.filter(([url]) =>
      [REDISPATCH_PATH, SOURCE_EVIDENCE_PATH].includes(new URL(url as string).pathname),
    );
    expect(writes).toHaveLength(5);
    for (const [, init] of writes) {
      expect((init as { body?: unknown }).body).toBe("");
    }
    const origins = writes.map(
      ([, init]) => (init as { headers: Record<string, string> }).headers.origin,
    );
    // The single cross-origin control forges evil.example deliberately.
    expect(origins.filter((o) => o === STAGING_URL)).toHaveLength(4);
    expect(origins.filter((o) => o === "https://evil.example")).toHaveLength(1);
    // Preview GETs assert their own explicit same-origin Origin; the
    // session-free evidence GETs send none.
    for (const [url, init] of send.mock.calls) {
      const path = new URL(url as string).pathname;
      const h = (init as { headers: Record<string, string> }).headers;
      if (path === PREVIEW_PATH) expect(h.origin).toBe(STAGING_URL);
      if (path === SOURCE_EVIDENCE_PATH && (init as { method?: string }).method !== "POST")
        expect(h.origin).toBeUndefined();
    }
  });

  it.each([
    { baseUrl: "https://togetherweown.com" },
    { baseUrl: `${STAGING_URL}/` },
    { baseUrl: `${STAGING_URL}.evil.test` },
    { token: "" },
  ])("fails before network for unsafe target/missing input %#", async (change) => {
    const send = vi.fn();
    await expect(runProbe({ token: "fixture-qa-token", fetch: send, ...change })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when a QA login is refused", async () => {
    const send = vi.fn(async () => response(404));
    await expect(runProbe({ token: "fixture-qa-token", fetch: send })).rejects.toThrow(
      "QA login as qa-member refused (HTTP 404)",
    );
  });
});
