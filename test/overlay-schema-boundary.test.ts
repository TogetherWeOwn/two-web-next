import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import migrationConfig from "../drizzle.config";
import { overlayConfigs, overlayTokens } from "../src/db/overlay-schema";
import * as pageSchema from "../src/db/schema";

describe("overlay schema bundle boundary", () => {
  it("does not load unused overlay tables into the page database namespace", () => {
    // admin/db spreads this namespace into the Kit request database. Overlay
    // lifecycle uses raw SQL and ships no page routes in this slice.
    expect(pageSchema).not.toHaveProperty("overlayConfigs");
    expect(pageSchema).not.toHaveProperty("overlayTokens");
  });

  it("keeps overlay metadata in migration generation with its one-live index", () => {
    expect(migrationConfig.schema).toContain("./src/db/overlay-schema.ts");
    expect(getTableConfig(overlayConfigs).name).toBe("overlay_configs");
    const tokens = getTableConfig(overlayTokens);
    expect(tokens.name).toBe("overlay_tokens");
    expect(tokens.indexes.map((index) => index.config.name)).toContain("overlay_tokens_member_idx");
    const liveIndex = tokens.indexes.find(
      (index) => index.config.name === "overlay_tokens_member_live_unique",
    );
    expect(liveIndex?.config.unique).toBe(true);
    expect(liveIndex?.config.where).toBeDefined();
    expect(tokens.checks.map((check) => check.name)).toContain("overlay_tokens_status_check");
  });
});
