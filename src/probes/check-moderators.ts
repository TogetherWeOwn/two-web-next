// Deploy-time moderator role-config probe. Port of two-web
// app/Console/Commands/CheckDiscordModerators.php (docs/parity.md §7).
//
// Legacy ran on the box reading config(); Workers have no config cache, so
// this reads the same value the login path parses — DISCORD_MODERATOR_ROLE_IDS
// — from the environment the operator hands it. Run it with the staging value
// during the W16 rehearsal. It never touches the network, so it cannot target
// production: there is nothing to target.
//
// Exit status is 0 when nothing FAILs, 1 otherwise. UNKNOWN never fails a run:
// see the legacy header ("the honest part") for what this cannot check — the
// live moderator-vs-member login round trip and the approved-role holder count.

import { isModerator, parseModeratorRoleIds } from "../roles";

export type ProbeStatus = "PASS" | "FAIL" | "UNKNOWN";
export type ProbeFinding = { status: ProbeStatus; name: string; detail: string };

export type ModeratorProbe = {
  findings: ProbeFinding[];
  failures: number;
  unknowns: number;
  ok: boolean;
};

/**
 * The approved website moderator roles in the production TWO guild, matched
 * by ID and never by name: `Owner` and `Moderator`. This pair replaces the
 * retired SySOp-only grant; widening or narrowing it needs fresh sign-off.
 * Verified from the 2026-10-13 role-cleanup census (round6/presnap).
 */
export const APPROVED_MODERATOR_ROLE_IDS: readonly string[] = [
  "1546777855801954408", // Owner
  "1546777856984481792", // Moderator
];

/** Production guild: TWO `326474832151838730`. */
export const PRODUCTION_GUILD_ID = "326474832151838730";

/** Staging guild: TWO Staging `1545644954272137297`. */
export const STAGING_GUILD_ID = "1545644954272137297";

/**
 * The approved website moderator roles in the staging guild: `Owner` and
 * `Moderator`. Verified from existing authorized staging snapshots on
 * TOG-1317 (latest `two-staging-clean-slate-export-2026-09-07.json`,
 * generated 2026-09-07T00:41:42Z). Discord role IDs are guild-scoped, so
 * this pair is unrelated to the production pair above — never copy one
 * guild's IDs into the other's config.
 */
export const STAGING_MODERATOR_ROLE_IDS: readonly string[] = [
  "1546211363578191873", // Owner (staging guild)
  "1545648550329851946", // Moderator (staging guild)
];

/**
 * Guild-bound approved pairs. Each environment's config must carry the pair
 * for the guild it queries; a production pair in a staging config (or vice
 * versa) matches nobody while looking configured.
 */
export const APPROVED_MODERATOR_ROLE_IDS_BY_GUILD: Record<string, readonly string[]> = {
  [STAGING_GUILD_ID]: STAGING_MODERATOR_ROLE_IDS,
  [PRODUCTION_GUILD_ID]: APPROVED_MODERATOR_ROLE_IDS,
};

/**
 * Roles that must never appear in the moderator list. The five other roles
 * that carry ban or kick are the *plausible* wrong answer (approved
 * 2026-08-19, reversed by the CEO three minutes later), and SySOp is the
 * retired role this migration removes. All are deleted or scheduled for
 * deletion by the approved server redesign / role consolidation — a deleted
 * snowflake matches nobody, forever, without erroring, so a list containing
 * them dark-fails exactly like a blank one while looking configured.
 */
export const DOOMED_MODERATOR_ROLE_IDS: Record<string, string> = {
  "508654771276873729": "SySOp (retired; delete once no config references it)",
  "1078757544169848933": "Officer (3 holders, DELETE in wave 6)",
  "1087192823767515219": "Staff (6 holders, DELETE in wave 6)",
  "1078757266469175386":
    "Game Master (old id, already deleted; live role recreated under a new id)",
  "1078757184021733426": "Captain (0 holders, DELETE in role-consolidation)",
  "1078756990710452365": "Lieutenant (0 holders, DELETE in role-consolidation)",
};

/** Raw entries: split, trim, drop empties — the same normalization the login path relies on. */
export function rawModeratorRoleIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function checkModerators(
  raw: string | undefined,
  opts?: { requireConfigured?: boolean; guildId?: string },
): ModeratorProbe {
  const configured = rawModeratorRoleIds(raw);
  const rendered = configured.length === 0 ? "<empty>" : configured.join(",");
  const findings: ProbeFinding[] = [];
  const record = (status: ProbeStatus, name: string, detail: string) =>
    findings.push({ status, name, detail });

  // Is anything set at all? Blank is correct in local dev and is the
  // documented revocation path — only a failure where the grant is supposed
  // to exist, which the caller states with requireConfigured.
  if (configured.length > 0) {
    record("PASS", "configured", `moderator_role_ids = ${rendered}`);
  } else if (opts?.requireConfigured) {
    const hintPair =
      opts?.guildId !== undefined
        ? APPROVED_MODERATOR_ROLE_IDS_BY_GUILD[opts.guildId]
        : APPROVED_MODERATOR_ROLE_IDS;
    record(
      "FAIL",
      "configured",
      `moderator_role_ids is empty. Nobody is a moderator and the admin link is offered to no one — silently. Set DISCORD_MODERATOR_ROLE_IDS=${hintPair?.join(",") ?? "<pair for this guild>"} in this environment.`,
    );
  } else {
    record(
      "PASS",
      "configured",
      "empty, and require-configured was not passed. Nobody is a moderator; this is the correct state for local dev and is the revocation path.",
    );
  }

  // None of the doomed snowflakes may appear.
  const found = configured.filter((id) => id in DOOMED_MODERATOR_ROLE_IDS);
  if (found.length === 0) {
    record(
      "PASS",
      "no-doomed-roles",
      `none of the ${Object.keys(DOOMED_MODERATOR_ROLE_IDS).length} retired/deleted roles are present`,
    );
  } else {
    const described = found.map((id) => `${id} = ${DOOMED_MODERATOR_ROLE_IDS[id]!}`).join("; ");
    record(
      "FAIL",
      "no-doomed-roles",
      `list contains role(s) that are deleted by the approved server redesign: ${described}. A deleted snowflake matches nobody and never errors, so this grant will silently stop working. The approved list is exactly Owner+Moderator; changing it needs fresh sign-off.`,
    );
  }

  // The signed-off value is exactly the approved Owner+Moderator pair for
  // this environment's guild (order-insensitive; duplicates do not count
  // twice). Without a guild the legacy production pair is the expectation.
  const expectedPair =
    opts?.guildId !== undefined
      ? APPROVED_MODERATOR_ROLE_IDS_BY_GUILD[opts.guildId]
      : APPROVED_MODERATOR_ROLE_IDS;
  const approved = expectedPair?.join(",") ?? "<unknown guild>";
  const unique = [...new Set(configured)];
  if (configured.length === 0) {
    record("UNKNOWN", "is-approved", "nothing configured, so there is nothing to compare");
  } else if (expectedPair === undefined) {
    record(
      "FAIL",
      "is-approved",
      `unknown guild ${opts?.guildId}: no approved pair exists for it. Configured: ${rendered}. Role IDs are guild-scoped, so an unrecognized guild can never match.`,
    );
  } else if (
    configured.length === expectedPair.length &&
    unique.length === expectedPair.length &&
    expectedPair.every((id) => unique.includes(id))
  ) {
    record(
      "PASS",
      "is-approved",
      opts?.guildId !== undefined
        ? `exactly the approved Owner+Moderator pair for guild ${opts.guildId} (${approved})`
        : `exactly the approved Owner+Moderator pair (${approved})`,
    );
  } else {
    const missing = expectedPair.filter((id) => !unique.includes(id));
    const extra = unique.filter((id) => !expectedPair.includes(id));
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing approved role(s): ${missing.join(",")}`);
    if (extra.length > 0) parts.push(`extra role(s): ${extra.join(",")}`);
    if (missing.length === 0 && extra.length === 0) parts.push("duplicate entries");
    record(
      "FAIL",
      "is-approved",
      `not exactly the approved Owner+Moderator pair (${approved}). Configured: ${rendered} (${parts.join("; ")}). Holders of approved roles would lose or gain the admin panel silently.`,
    );
  }

  // Guild binding: the configured pair must belong to the guild this
  // environment queries. Only emitted when the caller names a guild — legacy
  // callers without one keep the five findings above. A production pair in a
  // staging config (the pre-2026-10-14 staging state) fails here even though
  // every other finding can pass, because the offline checks cannot
  // otherwise see that the IDs do not exist in the queried guild.
  if (opts?.guildId !== undefined) {
    const bound = APPROVED_MODERATOR_ROLE_IDS_BY_GUILD[opts.guildId];
    if (bound === undefined) {
      record(
        "FAIL",
        "guild-binding",
        `unknown guild ${opts.guildId}: no approved moderator pair is bound to it, so this config can never grant. Known guilds: ${Object.keys(APPROVED_MODERATOR_ROLE_IDS_BY_GUILD).join(",")}.`,
      );
    } else if (configured.length === 0) {
      record(
        "UNKNOWN",
        "guild-binding",
        "nothing configured, so there is no pair to bind to the guild",
      );
    } else {
      const boundUnique = [...new Set(configured)];
      const matches =
        configured.length === bound.length &&
        boundUnique.length === bound.length &&
        bound.every((id) => boundUnique.includes(id));
      if (matches) {
        record(
          "PASS",
          "guild-binding",
          `configured pair is bound to guild ${opts.guildId} (${bound.join(",")})`,
        );
      } else {
        record(
          "FAIL",
          "guild-binding",
          `configured roles are not the pair bound to guild ${opts.guildId} (expected ${bound.join(",")}; configured ${rendered}). Role IDs are guild-scoped: this grant matches nobody in the queried guild while looking configured.`,
        );
      }
    }
  }

  // Shape, not membership. Deliberate divergence from legacy's /^[0-9]{17,20}$/:
  // the rule here is what this repo's login path actually enforces — an entry
  // parseModeratorRoleIds() drops can never match anything, whatever its
  // width. A name where an ID belongs (`Moderator`) is the mistake this catches.
  if (configured.length === 0) {
    record("UNKNOWN", "shape", "nothing configured, so there is nothing to check the shape of");
  } else {
    const allowed = new Set(parseModeratorRoleIds(raw));
    const malformed = configured.filter((id) => !allowed.has(id));
    if (malformed.length === 0) {
      record(
        "PASS",
        "shape",
        `${configured.length} entr${configured.length === 1 ? "y is a" : "ies are"} usable snowflake${configured.length === 1 ? "" : "s"} (survives the login path's parse)`,
      );
    } else {
      const shown = malformed.map((v) => `'${v}'`).join(", ");
      record(
        "FAIL",
        "shape",
        `not usable moderator role IDs: ${shown}. Roles are matched by exact string against the parsed list, so these entries can never match anything. A role name where an ID belongs is the usual cause.`,
      );
    }
  }

  // The fail-closed guarantee, re-derived from the same code the login path
  // reads rather than asserted. Everything above only means something because
  // an empty list denies rather than permits.
  const grantsOnEmpty = isModerator([...APPROVED_MODERATOR_ROLE_IDS], parseModeratorRoleIds(""));
  record(
    grantsOnEmpty ? "FAIL" : "PASS",
    "fails-closed",
    grantsOnEmpty
      ? "an empty moderator list grants the panel. Revocation by blanking the variable does not work."
      : "an empty moderator list grants nobody, so blanking the variable revokes cleanly with no deploy",
  );

  const failures = findings.filter((f) => f.status === "FAIL").length;
  const unknowns = findings.filter((f) => f.status === "UNKNOWN").length;
  return { findings, failures, unknowns, ok: failures === 0 };
}

export function renderModeratorReport(probe: ModeratorProbe): string {
  const width = Math.max(0, ...probe.findings.map((f) => f.name.length));
  const lines = probe.findings.map(
    (f) => `  ${f.status.padEnd(7)} ${f.name.padEnd(width)}  ${f.detail}`,
  );
  lines.push("");
  lines.push(
    `  ${probe.findings.length} checks: ${probe.findings.length - probe.failures - probe.unknowns} pass, ${probe.failures} fail, ${probe.unknowns} unknown`,
  );
  lines.push("  Not checkable from here: the live moderator-vs-member login round trip");
  lines.push("  (needs real Discord consent) and the current approved-role holder count (needs a");
  lines.push("  bot token, TOG-13). Both are named on TOG-427.");
  return lines.join("\n");
}
