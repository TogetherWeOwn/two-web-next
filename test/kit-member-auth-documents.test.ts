// Regression breaks: either admin-only probe gate left in place, missing/duplicate
// controllers, probes minted before audit release, or probe authority becoming login.
import { parseSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import { resolveRouteOwner } from "../src/route-ownership";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  SESSION_PREDECESSOR_GRACE_SECONDS,
  SESSION_TTL_SECONDS,
  hashToken,
  newSessionToken,
} from "../src/sessions";
import {
  BOARD,
  SELF,
  OTHER,
  OTHER_PROFILE,
  MEMBER,
  SECRET,
  kitMemberAuthFixture,
  memberAuthRenderers,
  type MemberAuthRenderers,
} from "./fixtures/kit-member-auth";

let render: MemberAuthRenderers;
beforeAll(async () => {
  render = await memberAuthRenderers();
});
afterAll(() => render?.dispose());
const documents = [BOARD, SELF, OTHER_PROFILE];
const controllers = (html: string) => [
  ...html.matchAll(/<script\b[^>]*src="\/islands\/auth-status\.js"[^>]*>/g),
];
const probe = (response: Response) =>
  response.headers.getSetCookie().find((value) => value.startsWith(`${AUTH_STATUS_COOKIE}=`));
const pair = (value: string) => value.split(";")[0]!;

function mutations(f: ReturnType<typeof kitMemberAuthFixture>) {
  return ["create", "replace", "rotate", "revoke", "revokeLineage", "revokeUserSessions"].map(
    (method) => vi.spyOn(f.sessions, method as "rotate"),
  );
}

describe("released Kit member documents: real ownership, bridge, audit and SSR", () => {
  it.each(documents)(
    "GET %s attaches one signed, non-authenticating probe without changing the session",
    async (path) => {
      const f = kitMemberAuthFixture(render);
      const login = await f.login();
      const writes = mutations(f);
      const response = await f.request(path, { headers: { cookie: login.cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-two-renderer")).toBe("kit");
      expect(response.headers.get("cache-control")).toContain("private");
      // Self reads cross the boundary without a foreign-subject access row.
      expect(f.audit).toHaveLength(path === SELF ? 0 : 1);
      const cookie = probe(response);
      expect(
        cookie,
        "successful audited member document needs the signed liveness probe",
      ).toBeDefined();
      for (const flag of [
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${SESSION_TTL_SECONDS}`,
      ])
        expect(cookie).toContain(flag);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      const signed = await parseSigned(pair(cookie!), SECRET);
      expect(signed[AUTH_STATUS_COOKIE]).toBe(await f.sessions.statusHash(login.tokenHash));
      expect(signed[AUTH_STATUS_COOKIE]).toMatch(/^[a-f0-9]{64}$/);
      expect((await parseSigned(pair(cookie!), `${SECRET}-wrong`))[AUTH_STATUS_COOKIE]).toBe(false);
      expect(
        response.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)),
      ).toBe(false);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    },
  );

  it.each(documents)("GET %s renders exactly one shipped auth-status controller", async (path) => {
    const f = kitMemberAuthFixture(render);
    const login = await f.login();
    const response = await f.request(path, { headers: { cookie: login.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(path === OTHER_PROFILE ? "Other member" : "Fixture member");
    if (path === BOARD) expect(html).toContain("<table");
    expect(
      controllers(html),
      "member markup must start one controller, not just show Sign out",
    ).toHaveLength(1);
    expect(controllers(html)[0]![0]).toContain("defer");
    expect(controllers(html)[0]![0]).toContain('data-testid="auth-tab-sync"');
  });

  it.each(documents)("guest and nonmember %s cannot gain a controller or cookie", async (path) => {
    for (const nonmember of [false, true]) {
      const f = kitMemberAuthFixture(render);
      let cookie = "";
      if (nonmember) {
        const login = await f.login();
        cookie = login.cookie;
        await f.sessions.create({
          tokenHash: login.tokenHash,
          userId: MEMBER,
          username: "Not a member",
          avatar: null,
          member: false,
          moderator: false,
          expiresAt: new Date(Date.now() + 3600_000),
        });
      }
      const response = await f.request(path, { headers: { cookie } });
      expect(response.status).toBe(nonmember ? 403 : 302);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(controllers(await response.text())).toHaveLength(0);
      expect(f.audit).toEqual([]);
    }
  });

  it.each([
    [BOARD, "readsFail"],
    [BOARD, "auditFails"],
    [SELF, "readsFail"],
    [OTHER_PROFILE, "readsFail"],
    [OTHER_PROFILE, "auditFails"],
  ] as const)("%s %s releases neither markup nor probe", async (path, failure) => {
    const f = kitMemberAuthFixture(render);
    const login = await f.login();
    f.state[failure] = true;
    const response = await f.request(path, { headers: { cookie: login.cookie } });
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = await response.text();
    expect(controllers(body)).toHaveLength(0);
    expect(body).not.toContain("Accepted bio");
    expect(body).not.toContain("Other member");
  });

  it.each(documents)(
    "HEAD, fragments and data at %s never mint probes or start controllers",
    async (path) => {
      for (const variant of ["HEAD", "fragment", "json"] as const) {
        const f = kitMemberAuthFixture(render);
        const login = await f.login();
        const response = await f.request(
          path,
          { method: variant === "HEAD" ? "HEAD" : "GET", headers: { cookie: login.cookie } },
          variant === "HEAD" ? "document" : variant,
        );
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(controllers(await response.text())).toHaveLength(0);
      }
    },
  );

  it("retains moderator admin behavior through both real probe gates", async () => {
    const f = kitMemberAuthFixture(render);
    const login = await f.login(undefined, true);
    const response = await f.request("/admin", { headers: { cookie: login.cookie } });
    expect(response.status).toBe(200);
    expect(controllers(await response.text())).toHaveLength(1);
    expect(probe(response)).toBeDefined();
    expect((await parseSigned(pair(probe(response)!), SECRET))[AUTH_STATUS_COOKIE]).toBe(
      await f.sessions.statusHash(login.tokenHash),
    );
  });

  it("keeps public documents session-free and profile twins held on the shipped dispatcher", async () => {
    const f = kitMemberAuthFixture(render);
    const response = await f.request("/hotzones");
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(controllers(await response.text())).toHaveLength(0);
    expect(f.state.sessionReads).toBe(0);
    expect(resolveRouteOwner({ method: "GET", path: BOARD })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/profile" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: OTHER_PROFILE })).toBe("hono");
    expect(resolveRouteOwner({ method: "PATCH", path: OTHER_PROFILE })).toBe("hono");
  });
});

// Member text must not impersonate an existing controller and suppress injection.
describe.each([
  { label: "self", path: SELF, subject: MEMBER },
  { label: "other", path: OTHER_PROFILE, subject: OTHER },
])("Kit $label profile bio cannot suppress the auth-status controller", ({ path, subject }) => {
  const outbound = vi.fn(async () => {
    throw new Error("Unexpected outbound member-bio acceptance request");
  });
  beforeEach(() => {
    outbound.mockClear();
    vi.stubGlobal("fetch", outbound);
  });
  afterEach(() => {
    try {
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { label: "normal bio", bio: "Accepted bio", escapedBio: "Accepted bio" },
    {
      label: "bare src substring",
      bio: 'I document src="/islands/auth-status.js" in my bio.',
      escapedBio: 'I document src="/islands/auth-status.js" in my bio.',
    },
    {
      label: "script-looking bio",
      bio: 'Literal <script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"></script> stays text.',
      escapedBio:
        'Literal &lt;script src="/islands/auth-status.js" defer data-testid="auth-tab-sync">&lt;/script> stays text.',
    },
  ])(
    "$label stays literal beside one real controller and a read-only probe",
    async ({ bio, escapedBio }) => {
      const f = kitMemberAuthFixture(render);
      await f.profiles.save(subject, { bio, games: ["Chess"], timezone: "Europe/London" });
      const login = await f.login();
      const before = await f.sessions.get(login.tokenHash);
      const writes = mutations(f);
      const response = await f.request(path, { headers: { cookie: login.cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-two-renderer")).toBe("kit");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(f.state.rendered).toBe(1);
      expect(f.state.sessionReads).toBe(1);
      expect(f.audit).toHaveLength(subject === MEMBER ? 0 : 1);
      if (subject !== MEMBER)
        expect(f.audit[0]).toMatchObject({ viewerUserId: MEMBER, subjectUserIds: [subject] });

      const html = await response.text();
      const bioMarkup = html.match(/<p\b[^>]*data-testid="profile-bio"[^>]*>([\s\S]*?)<\/p>/)?.[1];
      expect(bioMarkup).toBeDefined();
      // Walk past hydration comments without constructing rewritten markup.
      let literalIndex = 0;
      let controllerCount = 0;
      for (let index = 0; index < bioMarkup!.length; ) {
        if (bioMarkup!.startsWith("<!--", index)) {
          const end = bioMarkup!.indexOf("-->", index + 4);
          expect(end, "hydration comments must be closed").not.toBe(-1);
          index = end + 3;
          continue;
        }
        const nextComment = bioMarkup!.indexOf("<!--", index);
        const end = nextComment === -1 ? bioMarkup!.length : nextComment;
        const text = bioMarkup!.slice(index, end);
        expect(text, "the stored bio must reach real Svelte SSR as literal text").toBe(
          escapedBio.slice(literalIndex, literalIndex + text.length),
        );
        controllerCount += controllers(text).length;
        literalIndex += text.length;
        index = end;
      }
      expect(literalIndex).toBe(escapedBio.length);
      expect(controllerCount).toBe(0);
      expect((await f.profiles.find(subject))?.bio).toBe(bio);

      // Check the probe before the controller assertion: the bug leaves a valid
      // cookie on the response even though no executable controller is present.
      const cookie = probe(response);
      expect(cookie).toBeDefined();
      expect(response.headers.getSetCookie()).toHaveLength(1);
      for (const flag of [
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${SESSION_TTL_SECONDS}`,
      ])
        expect(cookie).toContain(flag);
      expect(cookie).not.toMatch(/Domain=/i);
      const signed = await parseSigned(pair(cookie!), SECRET);
      expect(signed[AUTH_STATUS_COOKIE]).toBe(await f.sessions.statusHash(login.tokenHash));
      expect(signed[AUTH_STATUS_COOKIE]).toMatch(/^[a-f0-9]{64}$/);
      expect((await parseSigned(pair(cookie!), `${SECRET}-wrong`))[AUTH_STATUS_COOKIE]).toBe(false);
      const status = await f.request("/auth/status", { headers: { cookie: pair(cookie!) } });
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ authenticated: true });
      expect(status.headers.getSetCookie()).toEqual([]);
      expect(await f.sessions.get(login.tokenHash)).toEqual(before);
      for (const write of writes) expect(write).not.toHaveBeenCalled();

      const scripts = controllers(html);
      expect(scripts, "literal bio text must not count as a shipped controller").toHaveLength(1);
      expect(scripts[0]![0]).toContain("defer");
      expect(scripts[0]![0]).toContain('data-testid="auth-tab-sync"');
    },
  );

  it("keeps an already-present real controller without injecting a duplicate", async () => {
    const controller =
      '<script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"></script>';
    const withController =
      (renderProfile: MemberAuthRenderers["profile"]) =>
      (data: Parameters<MemberAuthRenderers["profile"]>[0]) => {
        const html = renderProfile(data);
        expect(controllers(html)).toHaveLength(0);
        expect(html).toContain("</body>");
        return html.replace("</body>", `${controller}</body>`);
      };
    // Only this duplicate-suppression control adds a real script to SSR output;
    // the hostile-bio cases above always use the unmodified renderer and store.
    const f = kitMemberAuthFixture({
      ...render,
      profile: withController(render.profile),
      other: withController(render.other),
    });
    await f.profiles.save(subject, {
      bio: "Accepted bio",
      games: ["Chess"],
      timezone: "Europe/London",
    });
    const login = await f.login();
    const writes = mutations(f);
    const response = await f.request(path, { headers: { cookie: login.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-two-renderer")).toBe("kit");
    expect(f.state.rendered).toBe(1);
    expect(f.audit).toHaveLength(subject === MEMBER ? 0 : 1);
    const html = await response.text();
    expect(html).toContain("Accepted bio");
    expect(controllers(html)).toHaveLength(1);
    expect(html).toContain(controller);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(probe(response)).toBeDefined();
    expect((await parseSigned(pair(probe(response)!), SECRET))[AUTH_STATUS_COOKIE]).toBe(
      await f.sessions.statusHash(login.tokenHash),
    );
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});

describe("member-issued probe reads are authority-neutral", () => {
  it("survives token rotation without a new cookie, then reports real revocation without writes", async () => {
    vi.useFakeTimers();
    try {
      const f = kitMemberAuthFixture(render);
      const login = await f.login();
      const document = await f.request(BOARD, { headers: { cookie: login.cookie } });
      expect(probe(document)).toBeDefined();
      const cookie = pair(probe(document)!);
      const replacementHash = await hashToken(newSessionToken());
      expect(
        await f.sessions.rotate(login.tokenHash, {
          tokenHash: replacementHash,
          userId: MEMBER,
          username: "Fixture member",
          avatar: null,
          member: true,
          moderator: false,
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      ).toBe(true);
      // Predecessor grace: the rotated predecessor stays readable while the
      // successor lineage is live, then refuses once the 10s window lapses.
      expect(await f.sessions.get(login.tokenHash)).toMatchObject({
        userId: MEMBER,
        member: true,
      });
      expect(await f.sessions.get(replacementHash)).toMatchObject({
        userId: MEMBER,
        member: true,
      });
      vi.setSystemTime(Date.now() + SESSION_PREDECESSOR_GRACE_SECONDS * 1000 + 1);
      expect(await f.sessions.get(login.tokenHash)).toBeNull();
      expect(await f.sessions.get(replacementHash)).toMatchObject({
        userId: MEMBER,
        member: true,
      });
      const writes = mutations(f);
      const status = await f.request("/auth/status", { headers: { cookie } });
      expect(await status.json()).toEqual({ authenticated: true });
      expect(status.headers.getSetCookie()).toEqual([]);
      // A probe alone can check a lineage, but cannot enter a member document.
      const refused = await f.request(BOARD, { headers: { cookie } });
      expect(refused.status).toBe(302);
      expect(refused.headers.getSetCookie()).toEqual([]);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      await f.sessions.revoke(replacementHash);
      const revoked = await f.request("/auth/status", { headers: { cookie } });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ authenticated: false });
      expect(revoked.headers.getSetCookie()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a store outage is unknown (503), and an expired member lineage is false, never a cookie mutation", async () => {
    vi.useFakeTimers();
    try {
      const f = kitMemberAuthFixture(render);
      const login = await f.login(new Date(Date.now() + 60_000));
      const document = await f.request(BOARD, { headers: { cookie: login.cookie } });
      expect(probe(document)).toBeDefined();
      const cookie = pair(probe(document)!);
      vi.spyOn(f.sessions, "isActive").mockRejectedValueOnce(new Error("fixture outage"));
      const outage = await f.request("/auth/status", { headers: { cookie } });
      expect(outage.status).toBe(503);
      expect(outage.headers.getSetCookie()).toEqual([]);
      vi.setSystemTime(Date.now() + 60_001);
      const expired = await f.request("/auth/status", { headers: { cookie } });
      expect(expired.status).toBe(200);
      expect(await expired.json()).toEqual({ authenticated: false });
      expect(expired.headers.getSetCookie()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
