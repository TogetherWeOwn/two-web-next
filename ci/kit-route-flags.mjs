#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function kitRouteFlagsForFamily(family) {
  const selection = family || "hono";
  if (
    !["hono", "archive", "archive-static", "events", "home", "join", "ember-pages"].includes(
      selection,
    )
  ) {
    throw new Error("Unsupported Kit route family");
  }
  const ember = selection === "ember-pages";
  return {
    archive: String(selection === "archive" || selection === "archive-static"),
    static: String(selection === "archive-static"),
    events: String(selection === "events" || ember),
    home: String(selection === "home" || ember),
    join: String(selection === "join" || ember),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const flags = kitRouteFlagsForFamily(process.env.KIT_ROUTE_FAMILY);
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
