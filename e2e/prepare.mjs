import { randomBytes } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";

requireGithubRunner();
const database = requireTestDatabase(process.env.DATABASE_URL);
if (!process.env.GITHUB_ENV) throw new Error("Missing GitHub step environment file");
const qaToken = randomBytes(32).toString("hex");
const sessionSecret = randomBytes(32).toString("hex");
// Fresh non-production signing material for this runner, never repo secrets.
process.stdout.write(`::add-mask::${qaToken}\n::add-mask::${sessionSecret}\n`);
await writeFile(new URL(".dev.vars", import.meta.url), [
  `DATABASE_URL=${database}`, `QA_AUTH_TOKEN=${qaToken}`, `SESSION_SECRET=${sessionSecret}`,
  "DISCORD_CLIENT_SECRET=e2e-unused-client-secret", "DISCORD_BOT_TOKEN=e2e-unused-bot-token", "",
].join("\n"), { mode: 0o600 });
await appendFile(process.env.GITHUB_ENV, `E2E_QA_TOKEN=${qaToken}\n`);
