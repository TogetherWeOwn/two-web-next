import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCTION_APEX } from "../src/headers";
import { STAGING_APP_URL } from "../src/qa";
import { honoOwnedProductionDataRequest } from "../src/kit-worker-dispatch";

const PROD_URL = `https://${PRODUCTION_APEX}`;
const ALL_OFF = { APP_URL: PROD_URL };
const ARCHIVE_ON = { APP_URL: PROD_URL, KIT_ROUTE_ARCHIVE: "true" };
const STATIC_ON = { APP_URL: PROD_URL, KIT_ROUTE_ARCHIVE: "true", KIT_ROUTE_STATIC: "true" };

function req(path: string, method = "GET"): Request {
  return new Request(new URL(path, PROD_URL), { method });
}

describe("honoOwnedProductionDataRequest", () => {
  it.each([
    ["GET", "/admin/__data.json"],
    ["GET", "/admin/events/__data.json"],
    ["GET", "/members/__data.json"],
    ["GET", "/profile/__data.json"],
    ["GET", "/__data.json"],
    ["HEAD", "/members/__data.json"],
    ["HEAD", "/admin/__data.json"],
    ["GET", "/members/__data.json?x-sveltekit-invalidated=01"],
    ["GET", "/admin/__data.json?x-sveltekit-invalidated=11&foo=bar"],
    ["GET", "/members//__data.json"],
  ])("returns true for all-off production %s %s", (method, path) => {
    expect(honoOwnedProductionDataRequest(req(path, method), ALL_OFF)).toBe(true);
  });

  it("treats absent rollout flags and explicit false flags the same", () => {
    const explicit = { ...ALL_OFF, KIT_ROUTE_ARCHIVE: "false", KIT_ROUTE_STATIC: "false" };
    expect(honoOwnedProductionDataRequest(req("/admin/__data.json"), explicit)).toBe(true);
  });

  it("returns false for enabled archive data and true once the archive is disabled", () => {
    expect(honoOwnedProductionDataRequest(req("/events/past/__data.json"), ARCHIVE_ON)).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/events/past/__data.json?x=1"), ARCHIVE_ON)).toBe(
      false,
    );
    expect(
      honoOwnedProductionDataRequest(req("/events/past/__data.json", "HEAD"), ARCHIVE_ON),
    ).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/events/past/__data.json"), ALL_OFF)).toBe(true);
  });

  it("returns false for enabled static data and true once static is disabled", () => {
    for (const path of ["/about/__data.json", "/faq/__data.json"]) {
      expect(honoOwnedProductionDataRequest(req(path), STATIC_ON)).toBe(false);
      expect(honoOwnedProductionDataRequest(req(path), ARCHIVE_ON)).toBe(true);
      expect(honoOwnedProductionDataRequest(req(path), ALL_OFF)).toBe(true);
    }
  });

  it("keeps the disabled-static data Hono-owned while archive data stays Kit", () => {
    expect(honoOwnedProductionDataRequest(req("/events/past/__data.json"), ARCHIVE_ON)).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/about/__data.json"), ARCHIVE_ON)).toBe(true);
  });

  it.each([
    ["GET", "/"],
    ["GET", "/members"],
    ["GET", "/admin"],
    ["GET", "/about"],
    ["GET", "/events/past"],
    ["POST", "/members"],
    ["GET", "/members/data.json"],
    ["GET", "/members/__data.json/"],
    ["GET", "/members/__data.json.map"],
  ])("returns false for ordinary all-off production %s %s", (method, path) => {
    expect(honoOwnedProductionDataRequest(req(path, method), ALL_OFF)).toBe(false);
  });

  it("returns false for an encoded data suffix that Kit does not classify as data", () => {
    expect(honoOwnedProductionDataRequest(req("/members/%5F%5Fdata.json"), ALL_OFF)).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/admin/%5f%5fdata.json"), ALL_OFF)).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/members/__data%2Ejson"), ALL_OFF)).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/members%2F__data.json"), ALL_OFF)).toBe(false);
  });

  it.each([
    ["staging origin", { APP_URL: STAGING_APP_URL, KIT_ROUTE_ARCHIVE: "true" }],
    ["local origin", { APP_URL: "http://localhost:8787" }],
    ["unknown origin", { APP_URL: `https://other.${PRODUCTION_APEX}.invalid` }],
    ["subdomain of production", { APP_URL: `https://www.${PRODUCTION_APEX}` }],
    ["malformed APP_URL", { APP_URL: "not a url" }],
    ["empty APP_URL", { APP_URL: "" }],
    ["missing APP_URL", {}],
  ])("returns false for %s", (_label, env) => {
    expect(honoOwnedProductionDataRequest(req("/admin/__data.json"), env)).toBe(false);
    expect(honoOwnedProductionDataRequest(req("/members/__data.json"), env)).toBe(false);
  });

  it("is a pure decision that neither consumes the request nor mutates the environment", () => {
    const env = { ...ALL_OFF };
    const request = new Request(new URL("/admin/__data.json", PROD_URL), {
      method: "POST",
      body: "payload",
    });
    honoOwnedProductionDataRequest(request, env);
    expect(request.bodyUsed).toBe(false);
    expect(env).toEqual(ALL_OFF);
  });
});

describe("web/worker.js data-request wiring", () => {
  const source = readFileSync(new NodeURL("../web/worker.js", import.meta.url), "utf8");

  it("calls the helper once and honoFetch once", () => {
    expect(source.match(/honoOwnedProductionDataRequest\(/g)).toHaveLength(1);
    expect(source.match(/honoFetch\(/g)).toHaveLength(1);
  });

  it("imports the helper from the shared dispatch module", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*honoOwnedProductionDataRequest[^}]*\}\s*from\s*"\.\.\/src\/kit-worker-dispatch(\.ts)?"/,
    );
  });

  it("serves Hono-owned data requests before the adapter runs", () => {
    const helper = source.indexOf("honoOwnedProductionDataRequest(");
    const hono = source.indexOf("honoFetch(");
    const adapter = source.indexOf("adapter.fetch(");
    expect(source.match(/adapter\.fetch\(/g)).toHaveLength(1);
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(hono);
    expect(hono).toBeLessThan(adapter);
  });
});
