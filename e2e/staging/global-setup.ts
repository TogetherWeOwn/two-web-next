import { requireGithubRunner } from "../ci-only.mjs";
import { loginQaIdentities } from "./qa-login";

export default async function globalSetup(): Promise<void> {
  requireGithubRunner();
  await loginQaIdentities();
}
