import { requireGithubRunner } from "../ci-only.mjs";

export default async function globalSetup(): Promise<void> {
  requireGithubRunner();
  // No QA login here. Every POST /auth/qa/:identity spends the shared
  // `qa-login` throttle budget (10/min per runner IP), and each spec file
  // signs in its own scoped sessions anyway: the sign-in sweep revokes older
  // sessions per identity, so state files cannot be shared across files and
  // a global-setup login would only spend 2 of the 10 hits for nothing.
}
