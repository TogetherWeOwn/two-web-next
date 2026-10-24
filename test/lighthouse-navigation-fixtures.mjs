import { createRequire } from "node:module";
import { initializeConfig } from "lighthouse/core/config/config.js";
import desktopConfig from "lighthouse/core/config/desktop-config.js";

const require = createRequire(import.meta.url);
const mobile = require("../ci/lighthouserc.cjs").ci.collect.settings;
const qualityBudget = require("../ci/quality-budget.json");
const lighthouseVersion = require("lighthouse/package.json").version;
const settings = {};
for (const [profile, config, flags] of [
  ["mobile", undefined, mobile],
  [
    "desktop",
    desktopConfig,
    {
      onlyCategories: Object.keys(qualityBudget.categories),
      skipAudits: ["uses-http2", "canonical", "is-crawlable"],
    },
  ],
]) {
  settings[profile] = (await initializeConfig("navigation", config, flags)).resolvedConfig.settings;
}
let navigation = 0;

// Truthful synthetic navigation metadata, not a recorded crawl or attestation.
// Each call models a separate sequential navigation. To model a copy, clone the
// returned report; calling this helper intentionally creates a NEW navigation.
// Lighthouse emits fetchTime, gatherMode, timing.total/entries and resolved
// configSettings. A desktop preset is resolved through desktopConfig, not by
// treating the CLI-only `preset` flag as a configSettings field.
export function navigationMetadata(profile = "mobile", { deployed = false } = {}) {
  navigation += 1;
  const configSettings = structuredClone(settings[profile]);
  if (profile === "desktop" && deployed)
    configSettings.blockedUrlPatterns = ["*/cdn-cgi/challenge-platform/*"];
  return {
    lighthouseVersion,
    gatherMode: "navigation",
    fetchTime: new Date(Date.UTC(2026, 9, 24, 12) + navigation * 1000).toISOString(),
    timing: {
      total: 1000,
      entries: [{ name: "lh:runner:run", startTime: 0, duration: 1000 }],
    },
    configSettings,
  };
}
