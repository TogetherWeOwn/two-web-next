#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function kitRouteFlagsForFamily(family) {
  switch (family || "hono") {
    case "hono":
      return { archive: "false", static: "false" };
    case "archive":
      return { archive: "true", static: "false" };
    case "archive-static":
      return { archive: "true", static: "true" };
    default:
      throw new Error("Unsupported Kit route family");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const flags = kitRouteFlagsForFamily(process.env.KIT_ROUTE_FAMILY);
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output path");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `archive=${flags.archive}\nstatic=${flags.static}\n`,
      "utf8",
    );
  } catch (error) {
    console.error(`Kit route selection refused: ${error.message}`);
    process.exitCode = 1;
  }
}
