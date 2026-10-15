import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

// Staging database is PlanetScale us-east-1 and each statement is a Hyperdrive
// round trip, so the staging Worker runs beside it in aws:us-east-1 (the
// pre-repoint eu-central-1 pin sat beside the retired Neon branch).
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

  it("places the staging Worker in the AWS region of its PlanetScale database", () => {
    expect(main.placement).toEqual({ region: "aws:us-east-1" });
  });

  it("keeps production on default placement until its cutover decision", () => {
    expect(main.env?.production?.placement).toEqual({ mode: "off" });
  });
});
