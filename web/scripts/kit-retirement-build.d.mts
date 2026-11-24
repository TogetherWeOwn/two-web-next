import type { Adapter } from "@sveltejs/kit";
import type { Plugin } from "vite";

export function kitRetirementBuild(
  adapter: Adapter,
  mode: string | undefined,
): { adapter: Adapter; plugin: Plugin } | undefined;
