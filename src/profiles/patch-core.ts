import {
  PROFILE_COPY,
  PROFILE_HONEY_FIELD,
  PROFILE_OPENED_AT_FIELD,
  profileTrapTripped,
} from "../islands/contracts-member-profile";
import { SNOWFLAKE, type Verdict } from "./routes-shared";
import type { ProfileFormValues } from "./presentation";
import type { MemberView, ProfileStore } from "./store";
import { normalizeLeaderboardOptOut, validateProfile } from "./validation";

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

export type ProfileMemberAdmission =
  | { kind: "member"; id: string }
  | { kind: "guest" | "forbidden" | "unavailable" };

type Deps = {
  admitMember: () => Promise<ProfileMemberAdmission>;
  // Supply the existing 30/min verdict, including the caller's failure policy.
  throttle: (bucket: string) => Promise<Verdict>;
  storeFor: () => Promise<ProfileStore | null>;
};

type Outcome =
  | { kind: "guest" | "forbidden" | "unavailable" | "nonOwner" | "notFound" }
  | { kind: "badRequest"; reason: "invalidJson" | "nonObjectJson" }
  | { kind: "limited"; retryAfter: number }
  | { kind: "invalid"; fields: Record<string, string> }
  | { kind: "saved"; body: { saved: true; message: string } };

type SaveOutcome =
  | Extract<Outcome, { kind: "badRequest" | "invalid" | "saved" }>
  | { kind: "saveFailed"; error: unknown };

/** Shared admission for JSON PATCH and the native form override. */
export async function admitProfilePatch(
  subjectId: string,
  deps: Pick<Deps, "admitMember" | "throttle">,
) {
  const viewer = await deps.admitMember();
  if (viewer.kind !== "member") return viewer;

  // Existing Hono ordering: even an authenticated non-owner can get 429.
  const verdict = await deps.throttle(`profile-write:${viewer.id}`);
  if (verdict.limited) return { kind: "limited", retryAfter: verdict.retryAfter } as const;
  if (!SNOWFLAKE.test(subjectId) || viewer.id !== subjectId) return { kind: "nonOwner" } as const;
  return { kind: "owner", id: viewer.id } as const;
}

/** Validate and save once. The HTTP adapter supplies the admitted owner and
 * an existing profile, and handles parser diagnostics and save failures. */
export async function saveProfilePatch(
  owner: string,
  body: unknown,
  store: Pick<ProfileStore, "save">,
): Promise<SaveOutcome> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "badRequest", reason: "nonObjectJson" };
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
  if (!profileTrapTripped(input, Date.now())) {
    try {
      await store.save(owner, result.attrs);
    } catch (error) {
      return { kind: "saveFailed", error };
    }
  }
  return { kind: "saved", body: { saved: true, message: PROFILE_COPY.saved } };
}

/** JSON core for callers that supply their own admission and body reader. */
export async function patchProfileJson(
  subjectId: string,
  readJson: () => Promise<unknown>,
  deps: Deps,
): Promise<Outcome> {
  const admission = await admitProfilePatch(subjectId, deps);
  if (admission.kind !== "owner") return admission;
  const store = await deps.storeFor();
  if (!store) return { kind: "unavailable" };
  if (!(await store.find(admission.id))) return { kind: "notFound" };

  let body: unknown;
  try {
    body = await readJson();
  } catch {
    return { kind: "badRequest", reason: "invalidJson" };
  }
  const outcome = await saveProfilePatch(admission.id, body, store);
  if (outcome.kind === "saveFailed") throw outcome.error;
  return outcome;
}

export function profileDraftValues(
  input: Record<string, unknown>,
  member: MemberView,
): ProfileFormValues {
  return {
    bio: typeof input.bio === "string" ? input.bio : "",
    games_text:
      typeof input.games_text === "string"
        ? input.games_text
        : Array.isArray(input.games)
          ? input.games.filter((game): game is string => typeof game === "string").join("\n")
          : "",
    timezone: typeof input.timezone === "string" ? input.timezone : "",
    leaderboard_opt_out:
      normalizeLeaderboardOptOut(input.leaderboard_opt_out) ?? member.leaderboardOptOut ?? false,
  };
}
