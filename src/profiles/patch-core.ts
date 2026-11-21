import {
  PROFILE_COPY,
  PROFILE_HONEY_FIELD,
  PROFILE_OPENED_AT_FIELD,
  profileTrapTripped,
} from "../islands/contracts-member-profile";
import { SNOWFLAKE, type Verdict } from "./routes-shared";
import type { ProfileStore } from "./store";
import { validateProfile } from "./validation";

// Mirror the Hono PATCH allowlist until the route contracts can be integrated.
const writable = new Set([
  "bio",
  "games",
  "games_text",
  "timezone",
  "leaderboard_opt_out",
  PROFILE_HONEY_FIELD,
  PROFILE_OPENED_AT_FIELD,
]);

type MemberAdmission =
  | { kind: "member"; id: string }
  | { kind: "guest" | "forbidden" | "unavailable" };

type Deps = {
  admitMember: () => Promise<MemberAdmission>;
  // Supply the existing 30/min verdict, including the caller's failure policy.
  throttle: (bucket: string) => Promise<Verdict>;
  storeFor: () => Promise<ProfileStore | null>;
};

type Outcome =
  | { kind: "guest" | "forbidden" | "unavailable" | "nonOwner" | "notFound" | "badRequest" }
  | { kind: "limited"; retryAfter: number }
  | { kind: "invalid"; fields: Record<string, string> }
  | { kind: "saved"; body: { saved: true; message: string } };

/** Dormant JSON PATCH core. The future HTTP caller owns origin, body caps,
 * content negotiation and error reporting. Do not use a member-read audit
 * boundary here: the existing access log covers GET/HEAD, not PATCH. */
export async function patchProfileJson(
  subjectId: string,
  readJson: () => Promise<unknown>,
  deps: Deps,
): Promise<Outcome> {
  const viewer = await deps.admitMember();
  if (viewer.kind !== "member") return viewer;

  // Existing Hono ordering: even an authenticated non-owner can get 429.
  const verdict = await deps.throttle(`profile-write:${viewer.id}`);
  if (verdict.limited) return { kind: "limited", retryAfter: verdict.retryAfter };
  if (!SNOWFLAKE.test(subjectId) || viewer.id !== subjectId) return { kind: "nonOwner" };

  const store = await deps.storeFor();
  if (!store) return { kind: "unavailable" };
  if (!(await store.find(viewer.id))) return { kind: "notFound" };

  let body: unknown;
  try {
    body = await readJson();
  } catch {
    return { kind: "badRequest" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "badRequest" };
  }
  const input = body as Record<string, unknown>;
  if (!Object.keys(input).every((key) => writable.has(key))) {
    return {
      kind: "invalid",
      fields: { fields: "Only your bio, games, timezone and leaderboard setting can be changed." },
    };
  }
  const result = validateProfile(input);
  if (!result.ok) return { kind: "invalid", fields: result.errors };

  // Validate first, and keep the same success body whether the trap fired or not.
  if (!profileTrapTripped(input, Date.now())) await store.save(viewer.id, result.attrs);
  return { kind: "saved", body: { saved: true, message: PROFILE_COPY.saved } };
}
