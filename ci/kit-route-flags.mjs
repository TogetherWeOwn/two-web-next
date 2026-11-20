#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const families = ["hono", "archive", "archive-static", "events", "home", "join", "ember-pages"];

export function kitRouteFlagsForFamily(family) {
  const selection = family || "hono";
  if (!families.includes(selection)) throw new Error("Unsupported Kit route family");
  const ember = selection === "ember-pages";
  return {
    archive: String(selection === "archive" || selection === "archive-static"),
    static: String(selection === "archive-static"),
    events: String(selection === "events" || ember),
    home: String(selection === "home" || ember),
    join: String(selection === "join" || ember),
  };
}

export async function requireEnabledEmberRoutes(flags, routes) {
  const selected = Object.entries({ events: "/events", home: "/", join: "/join" }).filter(
    ([flag]) => flags[flag] === "true",
  );
  if (!selected.length) return;
  const manifest = routes ?? (await import("../src/route-ownership.ts")).ROUTE_MANIFEST;
  for (const [, path] of selected) {
    if (!manifest.some((entry) => entry.method === "GET" && entry.path === path && entry.enabled)) {
      throw new Error(`GET ${path} is not enabled in the Kit route manifest`);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { GITHUB_EVENT_NAME, KIT_ROUTE_FAMILY, KIT_STAGING_ROUTE_FAMILY } = process.env;
    const family =
      GITHUB_EVENT_NAME === "workflow_run"
        ? families.find((allowed) => allowed === KIT_STAGING_ROUTE_FAMILY)
        : KIT_ROUTE_FAMILY;
    const flags = kitRouteFlagsForFamily(family);
    await requireEnabledEmberRoutes(flags);
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output path");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(flags)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      "utf8",
    );
  } catch (error) {
    console.error(`Kit route selection refused: ${error.message}`);
    process.exitCode = 1;
  }
}
