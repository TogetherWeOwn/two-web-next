import type { Env } from "../../src/env";
import { fetchApp } from "./fetch-app";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

// Use the mounted app by default. The response is passed through so each test
// can inspect the SDK's actual JSON or SSE wire format.
export function fetchMcp(path: string, init: RequestInit, env: Env): Promise<Response> {
  return fetchApp(new Request(new URL(path, env.APP_URL), init), env, ctx);
}
