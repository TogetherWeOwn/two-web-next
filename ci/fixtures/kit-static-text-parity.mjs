import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { FALLBACK_INVITE } from "../../src/invite-fallback.ts";

const appUrl = "https://static.example.test";
const apex = "https://togetherweown.com";
const invite = "https://discord.com/invite/fixture?label=caf%C3%A9#join";
const requestId = "0123456789abcdef-LHR";
const markdown = "text/markdown; charset=utf-8";
const staticCache = "public, max-age=3600";
const privateCache = "no-store, private";
const noindex = "noindex, nofollow";
const stableHeaders = [
  "allow",
  "cache-control",
  "content-security-policy",
  "content-type",
  "etag",
  "location",
  "referrer-policy",
  "reporting-endpoints",
  "vary",
  "x-content-type-options",
  "x-frame-options",
  "x-robots-tag",
];

// The fetch callback is supplied by the generated fixture Worker or by a
// database-free local harness. Request URLs never leave the in-process seam.
export async function assertStaticTextParity(fetchWorker) {
  const send = async (
    path,
    { flag, status, kit, method = "GET", headers, bindings, origin = appUrl },
  ) => {
    const url = new URL(path, origin);
    const request = new Request(url, {
      method,
      headers: {
        "cf-ray": requestId,
        "x-request-id": "discard-this-fixture-id",
        host: url.host,
        origin,
        cookie: "web_session=synthetic",
        ...headers,
      },
    });
    const response = await fetchWorker(request, {
      APP_URL: origin,
      DATABASE_URL: undefined,
      DISCORD_INVITE_URL: invite.replace("caf%C3%A9", "café"),
      RULES_LAST_UPDATED: "2026-09-01",
      KIT_ROUTE_STATIC_TEXT: flag,
      ...bindings,
    });
    const label = `${method} ${path} (${flag ?? "unset"})`;
    assert.equal(response.status, status, label);
    assert.equal(response.headers.get("x-two-renderer"), kit ? "kit" : null, label);
    assert.equal(response.headers.get("x-request-id"), requestId, label);
    assert.equal(response.headers.has("set-cookie"), false, label);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    const body = await response.text();
    if (method === "HEAD" || status === 304) assert.equal(body, "", label);
    return {
      body,
      headers: Object.fromEntries(stableHeaders.map((h) => [h, response.headers.get(h)])),
    };
  };

  const pair = async (path, status, options = {}, kit = true) => {
    const enabled = await send(path, { ...options, status, flag: "true", kit });
    const off = await send(path, { ...options, status, kit: false });
    assert.deepEqual(enabled, off, `${options.method ?? "GET"} ${path}: wire parity`);
    return enabled;
  };

  const text = [
    ["/llms.txt", `${appUrl}/events.md`],
    ["/about.md", "Voice-first"],
    ["/faq.md", "How do I join?"],
    ["/rules.md", "1 September 2026"],
    ["/privacy.md", "Version 6"],
    ["/join.md", invite],
  ];
  for (const [path, phrase] of text) {
    const { body, headers } = await pair(path, 200, { headers: { accept: "text/html" } });
    assert.ok(body.includes(phrase), path);
    assert.equal(headers["content-type"], markdown, path);
    assert.equal(headers["cache-control"], staticCache, path);
    assert.equal(headers["x-robots-tag"], noindex, path);
    const bytes = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
    assert.equal(headers.etag, `"${Buffer.from(bytes).toString("hex")}"`, path);
    assert.deepEqual((await pair(path, 200, { method: "HEAD" })).headers, headers, path);
    for (const [method, validator] of [
      ["GET", headers.etag],
      ["GET", `"old", W/${headers.etag}`],
      ["HEAD", "*"],
    ]) {
      const cached = await pair(path, 304, { method, headers: { "if-none-match": validator } });
      assert.deepEqual(cached.headers, { ...headers, "content-type": null }, path);
    }
  }
  const apexText = await pair("/about.md", 200, { origin: apex });
  assert.ok(apexText.body.includes(`${apex}/about`));
  assert.equal(apexText.headers["x-robots-tag"], null);
  const stale = await pair("/about.md?fixture=kept", 200, {
    headers: { "if-none-match": '"old"' },
  });
  for (const flag of ["false", "TRUE"]) {
    assert.deepEqual(await send("/about.md", { flag, status: 200, kit: false }), stale);
  }
  const badInvite = { DISCORD_INVITE_URL: "https://discord.gg.example.test/fixture" };
  const join = await pair("/join.md", 200, { bindings: badInvite });
  assert.ok(join.body.includes(FALLBACK_INVITE));
  assert.ok(!join.body.includes(badInvite.DISCORD_INVITE_URL));

  for (const [path, location, bindings] of [
    ["/community?utm_source=fixture", "/"],
    ["/discord?drop=1", invite],
    ["/discord", FALLBACK_INVITE, badInvite],
    ["/login", "/auth/discord"],
    ["/login?next=%2Fevents%3Fview%3Dlist&drop=1", "/auth/discord?next=%2Fevents%3Fview%3Dlist"],
    ["/login?next=%2F%2Fexample.test&next=%2Fevents", "/auth/discord"],
    ["/login?next=%2F%5Cexample.test", "/auth/discord"],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const { body, headers } = await pair(path, 302, { method, bindings });
      assert.equal(headers.location, location, path);
      assert.equal(headers["cache-control"], privateCache, path);
      assert.equal(headers["content-type"], null, path);
      assert.equal(body, "", path);
    }
  }

  for (const [path, status] of [
    ...text.map(([path]) => [path, 200]),
    ...[
      ["/community", 302],
      ["/discord", 302],
      ["/login", 302],
    ],
  ]) {
    await pair(`/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`, status, {}, false);
    await pair(`${path}/`, 404, {}, false);
    await pair(`${path}/__data.json`, 404, {}, false);
    await pair(path, 404, { method: "POST" }, false);
  }
  await pair(
    "/login",
    403,
    { method: "POST", headers: { origin: "https://foreign.example.test" } },
    false,
  );
  await pair("/discord", 404, { headers: { host: "foreign.example.test" } }, false);
  await pair("/events.md", 503, {}, false);
  const event = await pair("/e/01j0000000000000000000abcd.md?keep=1", 301, {}, false);
  assert.equal(event.headers.location, "/e/01J0000000000000000000ABCD.md?keep=1");
}
