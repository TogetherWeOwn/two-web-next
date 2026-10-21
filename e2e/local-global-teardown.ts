import { request, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";
import {
  LOCAL_FIXTURE_ORIGIN,
  LOCAL_SWEEP_MAX_DURATION_MS,
  liveLocalFixtureGateQuery,
  loginLocalSweep,
  sweepLocalFixtures,
} from "./local-fixture-sweep.mjs";
import { sendTokenRequest } from "./qa-request.mjs";

export default async function globalTeardown(): Promise<void> {
  requireGithubRunner();
  // DB gate before the QA login (QA-LOGIN BUDGET FIX): the sweep's moderator
  // login spends the shared 10/min qa-login throttle that the parity step
  // shares, so clean runs — no live sweep-target fixtures — skip the login
  // and the HTTP pass entirely (0 spends). Dirty runs fall through to the
  // unchanged login + cancel pass below (the load-bearing cascade-breaker:
  // parity runs even after red journeys and needs clean fixtures). The gate
  // reads the same disposable CI Postgres the journeys used, never staging.
  const gate = liveLocalFixtureGateQuery();
  const probe = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
  try {
    const live = await probe.unsafe(gate.text, gate.values);
    if (live.length === 0) return;
  } finally {
    await probe.end();
  }

  const token = process.env.E2E_QA_TOKEN;
  if (!token) throw new Error("local fixture sweep: missing ephemeral CI QA token");

  // This standalone context does not inherit the project's local TLS settings.
  const api = await request.newContext({
    baseURL: LOCAL_FIXTURE_ORIGIN,
    ignoreHTTPSErrors: true,
  });
  const deadline = Date.now() + LOCAL_SWEEP_MAX_DURATION_MS;
  try {
    await loginLocalSweep(
      (options: Parameters<APIRequestContext["post"]>[1]) =>
        sendTokenRequest("local fixture sweep QA login", token, () =>
          api.post("/auth/qa/qa-moderator", {
            ...options,
            headers: { "X-TWO-QA-Auth": token, Origin: LOCAL_FIXTURE_ORIGIN },
          }),
        ),
      { deadline },
    );

    const swept = await sweepLocalFixtures(
      {
        get: (path: string, options: Parameters<APIRequestContext["get"]>[1]) =>
          sendTokenRequest("local fixture sweep list", token, () => api.get(path, options)),
        post: (path: string, options: Parameters<APIRequestContext["post"]>[1]) =>
          sendTokenRequest("local fixture sweep cancel", token, () => api.post(path, options)),
      },
      { deadline },
    );
    if (swept > 0) console.log(`local fixture sweep cancelled ${swept} orphaned RSVP fixture(s)`);
  } finally {
    await api.dispose();
  }
}
