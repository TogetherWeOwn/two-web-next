// Registers the extensionless-TS resolve hook for bin/*.mjs entry points.
// The repo imports TS relatively without extensions (Bundler resolution);
// plain node only resolves explicit paths, so without this the scripts below
// fail with ERR_MODULE_NOT_FOUND. Invoked via `node --import ./bin/ts-hook.mjs`.
import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
