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
// live moderator-vs-member login round trip and the SySOp holder count.

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
 * `SySOp` in the TWO guild — one holder, administrator class, signed off on
 * TOG-106 as the entire website staff list. Matched by ID and never by name:
 * SySOp is `KEEP (renamed Owner)` in Wave 6 of the approved server redesign,
 * and the rename preserves the snowflake.
 */
export const SYSOP_MODERATOR_ROLE_ID = "508654771276873729";

/**
 * The five other roles that carry ban or kick. They are the *plausible* wrong
 * answer (approved 2026-08-19, reversed by the CEO three minutes later), and
 * all five are deleted by the approved server redesign / role consolidation —
 * a deleted snowflake matches nobody, forever, without erroring, so a list
 * containing them dark-fails exactly like a blank one while looking configured.
 */
export const DOOMED_MODERATOR_ROLE_IDS: Record<string, string> = {
  "1078757544169848933": "Officer (3 holders, DELETE in wave 6)",
  "1087192823767515219": "Staff (6 holders, DELETE in wave 6)",
  "1078757266469175386": "Game Master (1 holder, DELETE in wave 6)",
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
  opts?: { requireConfigured?: boolean },
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
    record(
      "FAIL",
      "configured",
      `moderator_role_ids is empty. Nobody is a moderator and the admin link is offered to no one — silently. Set DISCORD_MODERATOR_ROLE_IDS=${SYSOP_MODERATOR_ROLE_ID} in this environment.`,
    );
  } else {
    record(
      "PASS",
      "configured",
      "empty, and require-configured was not passed. Nobody is a moderator; this is the correct state for local dev and is the revocation path.",
    );
  }

  // None of the five doomed snowflakes may appear.
  const found = configured.filter((id) => id in DOOMED_MODERATOR_ROLE_IDS);
  if (found.length === 0) {
    record(
      "PASS",
      "no-doomed-roles",
      "none of the 5 ban/kick roles scheduled for deletion are present",
    );
  } else {
    const described = found.map((id) => `${id} = ${DOOMED_MODERATOR_ROLE_IDS[id]!}`).join("; ");
    record(
      "FAIL",
      "no-doomed-roles",
      `list contains role(s) that are deleted by the approved server redesign: ${described}. A deleted snowflake matches nobody and never errors, so this grant will silently stop working. TOG-106 narrowed the list to SySOp alone; widening it needs fresh sign-off.`,
    );
  }

  // The signed-off value is exactly one ID.
  if (configured.length === 0) {
    record(
      "UNKNOWN",
      "is-sysop",
      "nothing configured, so there is nothing to compare against TOG-106",
    );
  } else if (configured.length === 1 && configured[0] === SYSOP_MODERATOR_ROLE_ID) {
    record(
      "PASS",
      "is-sysop",
      `exactly SySOp (${SYSOP_MODERATOR_ROLE_ID}), which is the value signed off on TOG-106`,
    );
  } else if (!configured.includes(SYSOP_MODERATOR_ROLE_ID)) {
    record(
      "FAIL",
      "is-sysop",
      `SySOp (${SYSOP_MODERATOR_ROLE_ID}) is not in the list. Configured: ${rendered}. The owner holds SySOp, so as configured the owner cannot reach the admin panel.`,
    );
  } else {
    const extra = configured.filter((id) => id !== SYSOP_MODERATOR_ROLE_ID).join(",");
    record(
      "FAIL",
      "is-sysop",
      `SySOp is present, but the list is not exactly one ID (extras: ${extra || "duplicate SySOp"}). TOG-106 signed off one ID; widening needs fresh approval.`,
    );
  }

  // Shape, not membership. Deliberate divergence from legacy's /^[0-9]{17,20}$/:
  // the rule here is what this repo's login path actually enforces — an entry
  // parseModeratorRoleIds() drops can never match anything, whatever its
  // width. A name where an ID belongs (`SySOp`) is the mistake this catches.
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
  const grantsOnEmpty = isModerator([SYSOP_MODERATOR_ROLE_ID], parseModeratorRoleIds(""));
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
  lines.push("  (needs real Discord consent) and the current SySOp holder count (needs a");
  lines.push("  bot token, TOG-13). Both are named on TOG-427.");
  return lines.join("\n");
}
