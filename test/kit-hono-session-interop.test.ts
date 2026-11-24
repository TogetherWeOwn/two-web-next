// route-inventory: GET /
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifySignedCookie } from "../src/http/signed-cookie";
import { kitAdminRenewalFor, kitDocumentRotationFor, kitSessionBridge } from "../src/kit-session";
import { SESSION_COOKIE } from "../src/session-cookie";
import { hashToken, SESSION_PREDECESSOR_GRACE_SECONDS } from "../src/sessions";
import { fixtureDiscord, MEMBER, recoveryFixture, SECRET } from "./fixtures/session-recovery";

const START = Date.parse("2030-01-01T12:00:00Z");
const GRACE_MS = SESSION_PREDECESSOR_GRACE_SECONDS * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.stubGlobal("fetch", fixtureDiscord);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sessionHeaders = (response: Response) =>
  response.headers.getSetCookie().filter((header) => header.startsWith(`${SESSION_COOKIE}=`));

const cookiePair = (header: string) => header.split(";", 1)[0] ?? "";

async function verifiedHash(cookie: string): Promise<string> {
  const token = await verifySignedCookie(cookie.slice(SESSION_COOKIE.length + 1), SECRET);
  expect(token, "the shared codec must verify the actual response cookie").not.toBeNull();
  return hashToken(token ?? "");
}

it.each([
  {
    name: "event-detail renewal",
    path: "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    moderator: false,
    renewFor: kitDocumentRotationFor,
  },
  {
    name: "admin renewal",
    path: "/admin/join-attempts",
    moderator: true,
    renewFor: kitAdminRenewalFor,
  },
])("$name interoperates with Hono rotation and predecessor grace", async (scenario) => {
  const { env, sessions, login, request } = recoveryFixture();
  const initial = await login(new Date(START + 3600_000), scenario.moderator);
  const kitSession = kitSessionBridge(env);
  const eventFor = (cookie: string) => {
    const url = new URL(scenario.path, env.APP_URL);
    return { request: new Request(url, { headers: { cookie } }), url, route: null };
  };
  const readKit = (cookie: string) => kitSession(eventFor(cookie));
  const readHono = (cookie: string) => request("/", { headers: { cookie } });
  const authenticated = {
    status: "authenticated",
    session: { userId: MEMBER, member: true, moderator: scenario.moderator },
  };
  const guest = { status: "guest", session: null };

  // Call the current Kit writers directly; no test route ownership changes.
  const event = eventFor(initial.cookie);
  const locals = await kitSession(event);
  expect(locals).toMatchObject(authenticated);
  const kitHeader = await scenario.renewFor(env)({ ...event, locals });
  expect(kitHeader).not.toBeNull();
  const kitCookie = cookiePair(kitHeader ?? "");
  const kitHash = await verifiedHash(kitCookie);
  expect(kitHash).not.toBe(initial.tokenHash);
  expect(await sessions.statusHash(kitHash)).toBe(initial.tokenHash);
  expect(await readKit(kitCookie)).toMatchObject(authenticated);

  vi.setSystemTime(START + GRACE_MS - 1);
  expect(await readKit(initial.cookie)).toMatchObject(authenticated);
  const grace = await readHono(initial.cookie);
  expect(grace.status).toBe(200);
  expect(await grace.text()).toContain("Fixture member");
  expect(sessionHeaders(grace)).toEqual([]);
  const kitSuccessorOnHono = await request("/profile", {
    method: "HEAD",
    headers: { cookie: kitCookie },
  });
  expect(kitSuccessorOnHono.status).toBe(200);
  expect(sessionHeaders(kitSuccessorOnHono)).toEqual([]);

  vi.setSystemTime(START + GRACE_MS);
  // Let Hono see the expired predecessor before any other read can prune it.
  const expired = await readHono(initial.cookie);
  expect(expired.status).toBe(200);
  expect(await expired.text()).toContain('data-testid="join"');
  expect(sessionHeaders(expired)).toEqual([]);
  expect(await readKit(initial.cookie)).toMatchObject(guest);

  // Hono reads the still-live Kit bearer, then rotates it through the shared
  // session service. Kit must accept the new Hono cookie and the now-retired
  // Kit cookie during the second grace interval, without conflating the two.
  const hono = await readHono(kitCookie);
  expect(hono.status).toBe(200);
  expect(await hono.text()).toContain("Fixture member");
  const headers = sessionHeaders(hono);
  expect(headers).toHaveLength(1);
  const honoCookie = cookiePair(headers[0] ?? "");
  const honoHash = await verifiedHash(honoCookie);
  expect(honoHash).not.toBe(kitHash);
  expect(await sessions.statusHash(honoHash)).toBe(initial.tokenHash);
  expect(await sessions.statusHash(kitHash)).toBeNull();
  expect(await readKit(honoCookie)).toMatchObject(authenticated);
  vi.setSystemTime(START + 2 * GRACE_MS - 1);
  expect(await readKit(kitCookie)).toMatchObject(authenticated);
  vi.setSystemTime(START + 2 * GRACE_MS);
  expect(await readKit(kitCookie)).toMatchObject(guest);
  expect(await readKit(honoCookie)).toMatchObject(authenticated);
});
