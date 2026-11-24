// Profile write admission: the per-member write throttle and the owner-only
// check. Split out of src/profiles/routes.tsx. Registered after the body
// limit and session gate on PATCH and form-override POST in routes-writes.tsx.
import type { Next } from "hono";
import postgres from "postgres";
import { warnAdmissionStoreFailure } from "../admission-diagnostics";
import { databaseOptions, databaseUrl } from "../db/connection";
import type { Env } from "../env";
import { nonOwnerProfileWrite, rateLimitExceeded } from "../errors";
import { checkJoinThrottle } from "../join/service";
import type { Sql } from "../sessions";
import { type Ctx, type ProfileDeps, SNOWFLAKE, type Verdict } from "./routes-shared";

export const PROFILE_WRITE_THROTTLE_PER_MINUTE = 30;

export async function profileWriteThrottleFor(env: Env, bucket: string): Promise<Verdict> {
  const url = databaseUrl(env);
  if (!url) return { limited: false };
  // web_throttle_hits comes from drizzle/1000. The runtime role stays read/write-only.
  const sql = postgres(url, databaseOptions) as unknown as Sql;
  return checkJoinThrottle(sql, bucket, PROFILE_WRITE_THROTTLE_PER_MINUTE);
}

export function admitWrite(deps: ProfileDeps) {
  const throttle = async (c: { env: Env }, bucket: string): Promise<Verdict> => {
    if (deps.throttle) return deps.throttle(bucket);
    return profileWriteThrottleFor(c.env, bucket);
  };
  return async (c: Ctx, next: Next) => {
    const viewer = c.get("viewer");
    const verdict = await throttle(c, `profile-write:${viewer.id}`).catch((err: unknown) => {
      warnAdmissionStoreFailure(c, "profile-write", err);
      return { limited: false } as Verdict;
    });
    if (verdict.limited) return rateLimitExceeded(c, verdict.retryAfter);
    // UserPolicy::updateProfile: owner only. Moderators do not edit others' profiles.
    const id = c.req.param("user") ?? "";
    if (!SNOWFLAKE.test(id) || viewer.id !== id) return nonOwnerProfileWrite(c);
    await next();
  };
}
