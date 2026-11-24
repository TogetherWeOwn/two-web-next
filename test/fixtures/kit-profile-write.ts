import { generateSignedCookie } from "hono/cookie";
import { expect, vi } from "vitest";
import type { Env } from "../../src/env";
import { BODY_LIMIT_BYTES } from "../../src/http/body-limit";
import { PROFILE_COPY } from "../../src/islands/contracts-member-profile";
import { writeKitProfile } from "../../src/profiles/kit-write";
import type { Verdict } from "../../src/profiles/routes-shared";
import { createMemoryProfileStore } from "../../src/profiles/store";
import { SESSION_COOKIE } from "../../src/session-cookie";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const OWNER = "111111111111111111";
const OTHER = "222222222222222222";
export const APP_URL = "https://fixture.example.test";
export const REQUEST_ID = "0123456789abcdef";
const secret = "fixture-only-profile-session-signing";
export const PATH = `/members/${OWNER}`;
export const baseline = {
  id: OWNER,
  username: "Fixture Member",
  bio: "Saved baseline",
  avatar: null,
  games: ["Chess"],
  timezone: "UTC",
  leaderboardOptOut: false,
};

type FixtureOptions = { noStore?: boolean; noThrottle?: boolean; requestId?: string };

export async function fixture(
  role: "guest" | "owner" | "non-member" | "moderator" = "owner",
  options: FixtureOptions = {},
) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  const credentials = await generateSignedCookie(SESSION_COOKIE, token, secret, {
    path: "/",
    secure: true,
  });
  const cookie = role === "guest" ? "" : credentials.split(";")[0]!;
  const id = role === "moderator" ? OTHER : OWNER;
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: id,
    username: "Fixture Viewer",
    avatar: null,
    member: role !== "non-member",
    moderator: role === "moderator",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const sessionGet = vi.spyOn(sessions, "get");
  const rotate = vi.spyOn(sessions, "rotate");
  const env = {
    APP_URL,
    SESSION_SECRET: secret,
    SESSION_STORE: sessions,
    DISCORD_CLIENT_ID: "",
    DISCORD_CLIENT_SECRET: "",
    DISCORD_BOT_TOKEN: "",
    DISCORD_GUILD_ID: "",
    DISCORD_INVITE_URL: "",
  } satisfies Env & { SESSION_STORE: typeof sessions };
  const store = createMemoryProfileStore([baseline]);
  const find = vi.spyOn(store, "find");
  const save = vi.spyOn(store, "save");
  const throttle = vi.fn<(bucket: string) => Promise<Verdict>>(async () => ({ limited: false }));
  const write = (
    body: string | URLSearchParams | ReadableStream<Uint8Array>,
    method = "PATCH",
    headers: Record<string, string> = {},
    path = PATH,
  ) =>
    writeKitProfile(
      new Request(APP_URL + path, {
        method,
        headers: {
          cookie,
          accept: "application/json",
          "content-type":
            body instanceof URLSearchParams
              ? "application/x-www-form-urlencoded"
              : "application/json",
          ...headers,
        },
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit),
      env,
      options.requestId ?? REQUEST_ID,
      {
        store: options.noStore ? undefined : store,
        throttle: options.noThrottle ? undefined : throttle,
        stats: async () => null,
      },
    );
  return { id, write, store, find, save, throttle, sessionGet, rotate };
}

export function response(result: Awaited<ReturnType<typeof writeKitProfile>>): Response {
  expect(result).toBeInstanceOf(Response);
  if (!(result instanceof Response)) throw new Error("Expected an HTTP response");
  return result;
}

type HttpCase = {
  name: string;
  request?: Parameters<Awaited<ReturnType<typeof fixture>>["write"]>;
  options?: FixtureOptions;
  setup?: (f: Awaited<ReturnType<typeof fixture>>) => void;
  status: number;
  vary?: "Cookie" | "Accept";
  allow?: string;
  retry?: string;
  contentType?: "text/html" | "text/plain";
  body?: string;
  draft?: { errors: Record<string, string> };
  log?: string;
  save?: boolean;
  beforeSession?: boolean;
};

const valid = '{"games":[]}';
const form = new URLSearchParams({ _method: "PATCH", bio: "Synthetic draft" });
const html = { accept: "text/html" };
const textBody = { "content-type": "text/plain" };
const multipart = { "content-type": "multipart/form-data" };
const outage = new (class PostgresError extends Error {
  code = "ECONNRESET";
})();
const cancelled = Object.assign(new Error(), { name: "PostgresError", code: "57014" });
const requestFailureLog = "Profile request failed; refusing contents.";
const saveFailureLog = "profile save failed";

export const httpCases: HttpCase[] = [
  {
    name: "caps a body before the session",
    request: ["x".repeat(BODY_LIMIT_BYTES.form + 1)],
    status: 413,
    vary: "Accept",
    beforeSession: true,
  },
  {
    name: "refuses a broken stream before the session",
    request: [
      new ReadableStream({ start: (controller) => controller.error(new Error("upload failed")) }),
    ],
    status: 400,
    vary: "Accept",
    beforeSession: true,
  },
  {
    name: "fails closed when the session store throws",
    log: "profiles could not resolve the session; refusing.",
    setup: (f) => {
      f.sessionGet.mockRejectedValueOnce(new Error("session failed"));
    },
    status: 503,
    vary: "Accept",
    retry: "60",
  },
  {
    name: "preserves the shared throttle retry header",
    setup: (f) => {
      f.throttle.mockResolvedValueOnce({ limited: true, retryAfter: 9 });
    },
    status: 429,
    vary: "Accept",
    retry: "9",
  },
  {
    name: "preserves the fail-open throttle outage",
    setup: (f) => {
      f.throttle.mockRejectedValueOnce(outage);
    },
    status: 200,
    save: true,
  },
  {
    name: "uses the default throttle without a database",
    options: { noThrottle: true },
    status: 200,
    save: true,
  },
  {
    name: "refuses when the profile store is absent",
    options: { noStore: true },
    status: 503,
    vary: "Accept",
    retry: "60",
  },
  {
    name: "returns 404 when the admitted owner profile is missing",
    setup: (f) => {
      f.find.mockResolvedValueOnce(null);
    },
    status: 404,
  },
  {
    name: "refuses a lookup result for the wrong owner",
    setup: (f) => {
      f.find.mockResolvedValueOnce({ ...baseline, id: OTHER });
    },
    status: 404,
  },
  {
    name: "maps a classified lookup outage",
    log: requestFailureLog,
    setup: (f) => {
      f.find.mockRejectedValueOnce(outage);
    },
    status: 503,
    vary: "Accept",
    retry: "60",
  },
  {
    name: "fails closed on an unclassified lookup error",
    log: requestFailureLog,
    setup: (f) => {
      f.find.mockRejectedValueOnce(new Error("store failed"));
    },
    status: 503,
    body: "Member data is temporarily unavailable.",
  },
  {
    name: "saves the POST override without an explicit games list",
    request: [form, "POST", html],
    status: 303,
    save: true,
  },
  {
    name: "accepts direct form PATCH",
    request: [new URLSearchParams({ games_text: "Go" }), "PATCH"],
    status: 200,
    save: true,
  },
  {
    name: "rejects a POST without the form override",
    request: [valid, "POST"],
    status: 405,
    vary: "Accept",
    allow: "GET, PATCH, POST",
    body: "method_not_allowed",
  },
  {
    name: "rejects an unreadable form override",
    request: ["broken multipart", "POST", { ...multipart, ...html }],
    status: 405,
    vary: "Accept",
    allow: "GET, PATCH, POST",
    body: "Method Not Allowed",
  },
  {
    name: "rejects unrecognized media for JSON clients",
    request: [valid, "PATCH", textBody],
    status: 415,
    vary: "Accept",
    body: "unsupported_media_type",
  },
  {
    name: "rejects unrecognized media for browsers",
    request: [valid, "PATCH", { ...textBody, ...html }],
    status: 415,
    vary: "Accept",
    body: "Check your request",
  },
  {
    name: "rejects unrecognized media for plain text clients",
    request: [valid, "PATCH", { ...textBody, accept: "text/plain" }],
    status: 415,
    vary: "Accept",
    body: "Unsupported Media Type",
  },
  {
    name: "refuses parsed non-object JSON with no trusted request ID",
    request: ["[]"],
    options: { requestId: "untrusted" },
    status: 400,
    vary: "Accept",
  },
  {
    name: "shares JSON validation messages",
    request: ["{}"],
    status: 422,
    body: "Games must be a list.",
  },
  {
    name: "retains a rejected draft with validation feedback",
    request: [
      new URLSearchParams({ _method: "PATCH", bio: "Synthetic draft", timezone: "Not/AZone" }),
      "POST",
      html,
    ],
    status: 422,
    draft: { errors: { timezone: "Choose a valid IANA timezone, e.g. Europe/London." } },
  },
  {
    name: "preserves the definite native save failure",
    log: saveFailureLog,
    request: [form, "POST", html],
    setup: (f) => {
      f.save.mockRejectedValueOnce(outage);
    },
    status: 503,
    draft: { errors: { save: PROFILE_COPY.saveFailed } },
    save: true,
  },
  {
    name: "preserves the uncertain native save failure",
    log: saveFailureLog,
    request: [form, "POST", html],
    setup: (f) => {
      f.save.mockRejectedValueOnce(cancelled);
    },
    status: 503,
    draft: { errors: { save: PROFILE_COPY.saveUncertain } },
    save: true,
  },
  {
    name: "preserves the definite JSON save failure",
    log: saveFailureLog,
    setup: (f) => {
      f.save.mockRejectedValueOnce(outage);
    },
    status: 503,
    vary: "Accept",
    retry: "60",
    body: "db_unavailable",
    save: true,
  },
  {
    name: "preserves the uncertain JSON save failure",
    log: saveFailureLog,
    setup: (f) => {
      f.save.mockRejectedValueOnce(cancelled);
    },
    status: 503,
    vary: "Accept",
    body: "profile_save_uncertain",
    save: true,
  },
  {
    name: "serves the negotiated 500 HTML",
    log: saveFailureLog,
    contentType: "text/html",
    body: "Something broke on our side",
    request: [valid, "PATCH", html],
    setup: (f) => {
      f.save.mockRejectedValueOnce(new Error("save failed"));
    },
    status: 500,
    vary: "Accept",
    save: true,
  },
  {
    name: "serves the negotiated 500 text",
    log: saveFailureLog,
    contentType: "text/plain",
    setup: (f) => {
      f.save.mockRejectedValueOnce(new Error("save failed"));
    },
    status: 500,
    vary: "Accept",
    body: "Could not save your profile.",
    save: true,
  },
];
