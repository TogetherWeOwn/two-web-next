import { expect, it } from "vitest";
import { admitsKitAdmin } from "../src/admin/kit-serving";
import { STAGING_APP_URL } from "../src/qa";

const loopback = "http://127.0.0.1:8787";
const operator = "/admin/ops-overrides";

it.each([
  [loopback, operator, "true", false, true],
  [STAGING_APP_URL, operator, "true", false, true],
  ["https://togetherweown.com", operator, "true", false, false],
  ["https://other.example", operator, "true", false, false],
  [loopback, operator, undefined, false, false],
  [loopback, operator, "True", false, false],
  [loopback, operator, "true", true, false],
  [loopback, operator + "/", "true", false, false],
  [loopback, "/admin/%6fps-overrides", "true", false, false],
] as const)(
  "checks literal admin admission for %s %s flag %s data %s",
  (app, path, flag, data, expected) => {
    const url = new URL(path, app);
    expect(admitsKitAdmin(new Request(url), url, data, app, flag)).toBe(expected);
  },
);
