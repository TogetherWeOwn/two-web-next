import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchKitSecurityTxt } from "../src/kit-security-txt-fetch";
import {
  dispatchHookRequest,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
} from "../src/route-ownership";
import { fetchApp } from "./helpers/fetch-app";
import { env as baseEnv } from "./helpers/member-data";

const PATH = "/.well-known/security.txt";
const CONTACT = "https://github.com/TogetherWeOwn/two-web-next/security/advisories/new";
const POLICY = "https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md";
const FOREIGN = "https://foreign.example.test";
const REQUEST_ID = "0123456789abcdef-IAD";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected outbound request")));
});

afterEach(() => {
  const outbound = fetch;
  vi.unstubAllGlobals();
  expect(outbound).not.toHaveBeenCalled();
});

async function compare(
  input: string,
  {
    appUrl = baseEnv.APP_URL,
    init,
    candidate = true,
    flag = "true",
    data = false,
    mounted = true,
  }: {
    appUrl?: string;
    init?: RequestInit;
    candidate?: boolean;
    flag?: string;
    data?: boolean;
    mounted?: boolean;
  } = {},
) {
  const unexpectedRead = vi.fn(() => {
    throw new Error("Unexpected database or session access");
  });
  const env = {
    ...baseEnv,
    APP_URL: appUrl,
    get ADMIN_DB() {
      return unexpectedRead();
    },
    get SESSION_STORE() {
      return unexpectedRead();
    },
  };
  const headers = new Headers(init?.headers);
  headers.set("cf-ray", REQUEST_ID);
  headers.set("x-forwarded-host", "forwarded.example.test");
  headers.set("forwarded", "host=forwarded.example.test;proto=http");
  headers.set("if-none-match", "*");
  headers.set("if-modified-since", "Fri, 01 Jan 2100 00:00:00 GMT");
  const url = input.startsWith("/") ? new URL(input, appUrl) : new URL(input);
  const request = new Request(url, { ...init, headers });
  const baseline = await fetchApp(new Request(request), env);
  const honoFetch = vi.fn((req: Request) => fetchApp(req, env));
  const resolve = vi.fn<Parameters<typeof dispatchHookRequest>[1]["resolve"]>(async (event) => {
    const response = fetchKitSecurityTxt(event.request, env);
    if (!response) throw new Error("The security.txt adapter declined an admitted route");
    return response;
  });
  const sessionFor = vi.fn().mockRejectedValue(new Error("Security.txt dispatch read a session"));
  // Stand in for a mounted Kit endpoint without registering it in the shared catalog.
  const response = await dispatchHookRequest(
    {
      request,
      url: data ? new URL(PATH, url) : url,
      route: { id: mounted ? (data ? PATH : url.pathname) : null },
      isDataRequest: data,
    },
    {
      appUrl,
      honoFetch,
      resolve,
      sessionFor,
      apiFamilies: [
        { flag, routes: [{ method: "GET", path: PATH, enabled: true, reads: "public" }] },
      ],
    },
  );

  expect(resolve).toHaveBeenCalledTimes(candidate ? 1 : 0);
  expect(honoFetch).toHaveBeenCalledTimes(candidate ? 0 : 1);
  expect(sessionFor).not.toHaveBeenCalled();
  expect(unexpectedRead).not.toHaveBeenCalled();
  expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(candidate ? KIT_RENDERER_VALUE : null);
  expect(response.status).toBe(baseline.status);
  expect(response.statusText).toBe(baseline.statusText);
  const candidateHeaders = new Headers(response.headers);
  candidateHeaders.delete(KIT_RENDERER_HEADER);
  expect([...candidateHeaders]).toEqual([...baseline.headers]);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes).toEqual(new Uint8Array(await baseline.arrayBuffer()));
  return { response, body: new TextDecoder().decode(bytes) };
}

it.each([
  ["https://togetherweown.com", "https://togetherweown.com", "TOGETHERWEOWN.COM:8443"],
  ["https://staging.example.test:8443//", "https://staging.example.test:8443", undefined],
  ["http://[::1]:8787", null, "[0:0:0:0:0:0:0:1]:8787"],
])(
  "preserves GET and HEAD on %s, including canonical and cache policy",
  async (appUrl, canonical, host) => {
    for (const method of ["GET", "HEAD"]) {
      const headers = new Headers({ origin: FOREIGN });
      if (host) headers.set("host", host);
      const { response, body } = await compare(`${PATH}?fixture=1`, {
        appUrl,
        init: { method, headers },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
      for (const name of ["etag", "last-modified", "vary", "x-robots-tag"])
        expect(response.headers.get(name), name).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
      if (method === "HEAD") {
        expect(body).toBe("");
      } else {
        const lines = body.split("\n");
        expect(lines).toContain(`Contact: ${CONTACT}`);
        expect(lines).toContain(`Policy: ${POLICY}`);
        expect(lines.filter((line) => line.startsWith("Canonical:"))).toEqual(
          canonical ? [`Canonical: ${canonical}${PATH}`] : [],
        );
      }
    }
  },
);

it("leaves disabled, unmounted and encoded requests with Hono", async () => {
  for (const { response, body } of [
    await compare(PATH, { candidate: false, flag: "false" }),
    await compare(PATH, { candidate: false, mounted: false }),
    await compare("/.well-known/%73ecurity.txt", { candidate: false }),
  ]) {
    expect(response.status).toBe(200);
    expect(body).toContain(`Contact: ${CONTACT}\n`);
  }
});

it("keeps unrelated paths, data requests, untrusted hosts and unsafe methods out of the candidate", async () => {
  const refusals = [
    ["/security.txt", {}, 404],
    [`${PATH}/`, {}, 404],
    [`${PATH}/__data.json`, { data: true }, 404],
    [PATH, { data: true }, 200],
    [`${FOREIGN}${PATH}`, { init: { headers: { host: "next.example.test" } } }, 404],
    [PATH, { init: { headers: { host: "foreign.example.test" } } }, 404],
    [PATH, { init: { headers: { host: "next.example.test, foreign.example.test" } } }, 404],
    [`${baseEnv.APP_URL}${PATH}`, { appUrl: "invalid origin" }, 404],
    [PATH, { init: { method: "POST", headers: { origin: baseEnv.APP_URL } } }, 404],
    [
      PATH,
      { init: { method: "POST", headers: { origin: FOREIGN, accept: "application/json" } } },
      403,
    ],
  ] as const;
  for (const [path, options, status] of refusals) {
    const { response, body } = await compare(path, { ...options, candidate: false });
    expect(response.status, path).toBe(status);
    if (status !== 200) {
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(body).not.toContain(CONTACT);
    }
  }
});

it("declines other methods and nonliteral paths at the detached response boundary", () => {
  expect(
    fetchKitSecurityTxt(new Request(new URL(PATH, baseEnv.APP_URL), { method: "POST" }), baseEnv),
  ).toBeNull();
  for (const path of ["/security.txt", "/.well-known/%73ecurity.txt", `${PATH}/`]) {
    expect(fetchKitSecurityTxt(new Request(new URL(path, baseEnv.APP_URL)), baseEnv)).toBeNull();
  }
});
