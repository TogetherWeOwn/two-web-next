import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

// Staging Neon is eu-central-1 and each statement is a Hyperdrive round trip. Served from
// US colos (where GitHub-hosted runners land) DB-bound requests had a median of 0.5-1.8 s
// and a p95 of 3-4.6 s; from CDG/AMS 125-195 ms. The staging Worker runs beside its database.
// Production's database is elsewhere, so it must not inherit this pin.
const main = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8")) as {
  placement?: unknown;
  hyperdrive?: { binding: string; id: string }[];
  env?: {
    production?: {
      placement?: unknown;
      hyperdrive?: { binding: string; id: string }[];
    };
  };
};

describe("Worker placement (wrangler.jsonc)", () => {
  it("binds the bot-reader Hyperdrive separately in staging and production", () => {
    expect(main.hyperdrive).toContainEqual({
      binding: "BOT_DB",
      id: "63e6e86a91cb4e40b3ee54f459c8b450",
    });
    expect(main.env?.production?.hyperdrive).toContainEqual({
      binding: "BOT_DB",
      id: "14c00d84d1d446c1b117861f3b49473f",
    });
  });

  it("places the staging Worker in the AWS region of its Neon database", () => {
    expect(main.placement).toEqual({ region: "aws:eu-central-1" });
  });

  it("keeps production on default placement until its cutover decision", () => {
    expect(main.env?.production?.placement).toEqual({ mode: "off" });
  });
});
