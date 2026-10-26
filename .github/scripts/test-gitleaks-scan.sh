#!/usr/bin/env bash
# Offline self-test for gitleaks-scan.sh: a pull request or merge-queue commit
# must not be able to silence the secret scan that gates it.
#
# Builds throwaway git repos (a "base" commit on main plus a PR commit on top,
# with refs/remotes/origin/main standing in for the fetched base branch) and
# runs the real wrapper with the real gitleaks binary. The planted token is
# synthetic: it is derived at run time from a hash, so neither this file nor
# the repo history contains a string that looks like a credential. Nothing here
# touches the network, a real credential or the workspace under test.
#
# Usage: GITLEAKS_BIN=/path/to/gitleaks .github/scripts/test-gitleaks-scan.sh
set -euo pipefail

: "${GITLEAKS_BIN:?GITLEAKS_BIN must point at the verified gitleaks binary}"
GITLEAKS_BIN="$(readlink -f "${GITLEAKS_BIN}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scan="${here}/gitleaks-scan.sh"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/gitleaks-selftest.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

# A GitHub-PAT-shaped literal that matches the stock `github-pat` rule.
token="ghp_$(printf 'two-bot-next gitleaks self-test fixture' | sha256sum | cut -c1-36)"

failures=0
cases=0

# new_repo NAME: repo with one base commit, remote-tracking main pointing at it.
new_repo() {
  repo="${work}/$1"
  mkdir -p "${repo}"
  git -C "${repo}" init -q -b main
  git -C "${repo}" config user.email selftest@example.invalid
  git -C "${repo}" config user.name selftest
  git -C "${repo}" config commit.gpgsign false
  printf '# base\n' > "${repo}/README.md"
}

# base_commit: commit everything staged in the working tree as the base branch.
base_commit() {
  git -C "${repo}" add -A
  git -C "${repo}" commit -q -m base
  git -C "${repo}" update-ref refs/remotes/origin/main HEAD
}

# pr_commit: commit the working-tree changes as the PR head.
pr_commit() {
  git -C "${repo}" add -A
  git -C "${repo}" commit -q -m pr
}

plant_token() {
  printf 'value = "%s"\n' "${token}" > "${repo}/fixture.txt"
}

write_stock_config() {
  cat > "${repo}/.gitleaks.toml" <<'TOML'
[extend]
useDefault = true
TOML
}

write_allowlist_config() {
  cat > "${repo}/.gitleaks.toml" <<'TOML'
[extend]
useDefault = true

[[allowlists]]
description = "allowlist for the planted fixture"
paths = ['''^fixture\.txt$''']
TOML
}

# Stock rules, for fingerprinting findings independent of any repo policy.
printf '[extend]\nuseDefault = true\n' > "${work}/stock.toml"

# scan EVENT [BASE_REF] [WRAPPER]: run the wrapper in ${repo}; prints its exit code.
scan_rc() {
  local rc=0
  (cd "${repo}" && GITLEAKS_BIN="${GITLEAKS_BIN}" EVENT_NAME="$1" BASE_REF="${2:-main}" \
    "${3:-${scan}}" >"${work}/last.log" 2>&1) || rc=$?
  printf '%s' "${rc}"
}

# expect NAME WANT_RC GOT_RC
expect() {
  cases=$((cases + 1))
  if [[ "$2" == "$3" ]]; then
    printf 'ok   %s (exit %s)\n' "$1" "$3"
  else
    failures=$((failures + 1))
    printf 'FAIL %s: want exit %s, got %s\n' "$1" "$2" "$3"
    sed 's/^/     | /' "${work}/last.log" | tail -n 25
  fi
}

# fingerprint_of CONFIG: gitleaks fingerprint of the planted finding in ${repo}.
fingerprint_of() {
  (cd "${repo}" && "${GITLEAKS_BIN}" git . --config "$1" --log-opts=HEAD --no-banner \
    --exit-code 0 --report-format json --report-path - 2>/dev/null) \
    | grep -o '"Fingerprint": "[^"]*"' | head -n 1 | cut -d'"' -f4
}

# -- controls: the scan detects the token and passes a clean PR ---------------
new_repo clean
write_stock_config
base_commit
printf 'more docs\n' >> "${repo}/README.md"
pr_commit
expect "pr: clean change passes" 0 "$(scan_rc pull_request)"

new_repo plain
write_stock_config
base_commit
plant_token
pr_commit
expect "pr: planted token is detected" 1 "$(scan_rc pull_request)"

# -- the bypasses a PR could add itself ---------------------------------------
new_repo pr-config
write_stock_config
base_commit
plant_token
write_allowlist_config
pr_commit
expect "pr: allowlist added in .gitleaks.toml does not silence the scan" 1 "$(scan_rc pull_request)"

new_repo pr-ignore
write_stock_config
base_commit
plant_token
pr_commit
fp="$(fingerprint_of "${work}/stock.toml")"
if [[ -z "${fp}" ]]; then
  failures=$((failures + 1))
  echo "FAIL pr: could not derive the fingerprint of the planted token"
else
  printf '%s\n' "${fp}" > "${repo}/.gitleaksignore"
  pr_commit
  expect "pr: fingerprint added in .gitleaksignore does not silence the scan" 1 "$(scan_rc pull_request)"
fi

new_repo pr-ignore-edit
write_stock_config
printf '# base ignore file with only a comment\n' > "${repo}/.gitleaksignore"
base_commit
plant_token
pr_commit
fp="$(fingerprint_of "${work}/stock.toml")"
printf '%s\n' "${fp}" >> "${repo}/.gitleaksignore"
pr_commit
expect "pr: fingerprint appended to an existing .gitleaksignore does not silence the scan" 1 "$(scan_rc pull_request)"

# A repo-local wrapper must survive a PR-controlled ignore symlink to itself.
new_repo pr-ignore-symlink
write_stock_config
printf '# base ignore file with only a comment\n' > "${repo}/.gitleaksignore"
mkdir -p "${repo}/.github/scripts"
cp "${scan}" "${repo}/.github/scripts/gitleaks-scan.sh"
base_commit
rm -f "${repo}/.gitleaksignore"
ln -s .github/scripts/gitleaks-scan.sh "${repo}/.gitleaksignore"
plant_token
pr_commit
expect "pr: .gitleaksignore symlink cannot overwrite the running wrapper" 1 \
  "$(scan_rc pull_request main "${repo}/.github/scripts/gitleaks-scan.sh")"

new_repo pr-inline
write_stock_config
base_commit
printf 'value = "%s" # gitleaks:allow\n' "${token}" > "${repo}/fixture.txt"
pr_commit
expect "pr: inline gitleaks:allow does not silence the scan" 1 "$(scan_rc pull_request)"

# -- policy that already merged is still honoured -----------------------------
new_repo base-allowlist
write_allowlist_config
base_commit
plant_token
pr_commit
expect "pr: allowlist already on the base branch is honoured" 0 "$(scan_rc pull_request)"

new_repo base-ignore
write_stock_config
plant_token
git -C "${repo}" add -A
git -C "${repo}" commit -q -m "token on the base branch"
fp="$(fingerprint_of "${work}/stock.toml")"
printf '%s\n' "${fp}" > "${repo}/.gitleaksignore"
base_commit
printf 'more docs\n' >> "${repo}/README.md"
pr_commit
expect "pr: .gitleaksignore already on the base branch is honoured" 0 "$(scan_rc pull_request)"

# -- base branch without any policy files -------------------------------------
new_repo no-base-config
base_commit
printf 'more docs\n' >> "${repo}/README.md"
pr_commit
expect "pr: base without policy files, clean change passes" 0 "$(scan_rc pull_request)"

new_repo no-base-config-leak
base_commit
plant_token
write_allowlist_config
pr_commit
expect "pr: base without policy files, PR-added allowlist is ignored" 1 "$(scan_rc pull_request)"

# -- fail closed when the base branch is missing ------------------------------
new_repo no-base-ref
base_commit
printf 'more docs\n' >> "${repo}/README.md"
pr_commit
expect "pr: unfetched base branch fails the scan" 2 "$(scan_rc pull_request missing-branch)"

# -- non-PR runs keep the repo's own (already merged) policy ------------------
new_repo push-allowlist
write_allowlist_config
plant_token
base_commit
expect "push: merged allowlist is honoured" 0 "$(scan_rc push)"

new_repo push-leak
write_stock_config
plant_token
base_commit
expect "push: planted token is detected" 1 "$(scan_rc push)"

# -- merge_group runs honour the base policy, never the queue commit's own ---
# BASE_REF arrives as a full ref (refs/heads/main) on merge_group, so every
# case below passes it that way to prove the wrapper strips the prefix.
new_repo mg-clean
write_stock_config
base_commit
printf 'more docs\n' >> "${repo}/README.md"
pr_commit
expect "merge_group: clean change passes" 0 "$(scan_rc merge_group refs/heads/main)"

new_repo mg-plain
write_stock_config
base_commit
plant_token
pr_commit
expect "merge_group: planted token is detected" 1 "$(scan_rc merge_group refs/heads/main)"

new_repo mg-config
write_stock_config
base_commit
plant_token
write_allowlist_config
pr_commit
expect "merge_group: allowlist added in .gitleaks.toml does not silence the scan" 1 \
  "$(scan_rc merge_group refs/heads/main)"

new_repo mg-ignore
write_stock_config
base_commit
plant_token
pr_commit
fp="$(fingerprint_of "${work}/stock.toml")"
if [[ -z "${fp}" ]]; then
  failures=$((failures + 1))
  echo "FAIL merge_group: could not derive the fingerprint of the planted token"
else
  printf '%s\n' "${fp}" > "${repo}/.gitleaksignore"
  pr_commit
  expect "merge_group: fingerprint added in .gitleaksignore does not silence the scan" 1 \
    "$(scan_rc merge_group refs/heads/main)"
fi

new_repo mg-base-allowlist
write_allowlist_config
base_commit
plant_token
pr_commit
expect "merge_group: allowlist already on the base branch is honoured" 0 \
  "$(scan_rc merge_group refs/heads/main)"

new_repo mg-no-base-ref
base_commit
printf 'more docs\n' >> "${repo}/README.md"
pr_commit
expect "merge_group: unfetched base branch fails the scan" 2 \
  "$(scan_rc merge_group refs/heads/missing-branch)"

# -- candidate Hono fixture exception: real rules, exact git-relative paths ---
# Read the actual candidate policy, not a copy of the entry under test. These
# direct scans test the policy before it becomes the wrapper's trusted base.
hono_policy="${here}/../../.gitleaks.toml"
hono_path="test/hono-no-member-data-contract.test.ts"
hono_id_one="$(printf '%s' 111 222 333 444 555 667)"
hono_id_two="$(printf '%s' 222 333 444 555 666 778)"

plant_hono_ids() {
  mkdir -p "${repo}/$(dirname "$1")"
  printf 'discord_client_id = "%s"\ndiscord_client_id = "%s"\n' \
    "${hono_id_one}" "${hono_id_two}" > "${repo}/$1"
}

# expect_policy_scan NAME CONFIG WANT_RC EXPECTED_JSON
# Compare the complete redacted report, including count, rule, path and line.
# A scanner error, missing/empty report or unexpected finding fails closed.
expect_policy_scan() {
  local rc=0 report="${work}/hono-report.json" verdict=0
  rm -f "${report}"
  (cd "${repo}" && "${GITLEAKS_BIN}" git . --config "$2" --log-opts=HEAD \
    --redact=100 --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path "${work}/empty.ignore" \
    --exit-code 1 --report-format json --report-path "${report}" \
    >"${work}/last.log" 2>&1) || rc=$?
  python3 - "${report}" "${rc}" "$3" "$4" <<'PY' || verdict=$?
import json
import sys

try:
    report = json.load(open(sys.argv[1], encoding="utf-8"))
    expected = json.loads(sys.argv[4])
    if sys.argv[2] != sys.argv[3]:
        raise ValueError(f"scanner exit: expected {sys.argv[3]}, got {sys.argv[2]}")
    if not isinstance(report, list) or len(report) != len(expected):
        raise ValueError(f"report count: expected {len(expected)} findings")
    actual = sorted([row["RuleID"], row["File"], row["StartLine"]] for row in report)
    if actual != sorted(expected):
        raise ValueError(f"rule/path/line mismatch: expected {sorted(expected)}, got {actual}")
    if any(row["Secret"] != "REDACTED" or "REDACTED" not in row["Match"] for row in report):
        raise ValueError("report is not fully redacted")
except (OSError, ValueError, KeyError, TypeError) as error:
    print(f"FAIL Hono policy report: {error}")
    sys.exit(1)
PY
  expect "$1" 0 "${verdict}"
}

# An empty ignore file prevents any caller-local fingerprint exemptions.
: > "${work}/empty.ignore"
new_repo hono-approved
plant_hono_ids "${hono_path}"
base_commit
expect_policy_scan "Hono: stock rules detect both approved fixture ids" "${work}/stock.toml" 1 \
  '[["discord-client-id","test/hono-no-member-data-contract.test.ts",1],["discord-client-id","test/hono-no-member-data-contract.test.ts",2]]'
expect_policy_scan "Hono: candidate excludes both approved ids at the exact path" "${hono_policy}" 0 '[]'

new_repo hono-other-secrets
mkdir -p "${repo}/test"
printf 'discord_client_id = "%s"\nvalue = "%s"\n' \
  "$(printf '%s' 333 444 555 666 777 889)" "${token}" > "${repo}/${hono_path}"
base_commit
expect_policy_scan "Hono: another Discord id and another secret rule remain detected at the allowed path" \
  "${hono_policy}" 1 \
  '[["discord-client-id","test/hono-no-member-data-contract.test.ts",1],["github-pat","test/hono-no-member-data-contract.test.ts",2]]'

for path in \
  test/other.test.ts \
  nested/test/hono-no-member-data-contract.test.ts \
  test/hono-no-member-data-contract.test.ts.bak \
  test/hono-no-member-data-contractXtest.ts \
  test/hono-no-member-data-contract.testXts; do
  new_repo "hono-path-${cases}"
  plant_hono_ids "${path}"
  base_commit
  expected="$(printf '[["discord-client-id","%s",1],["discord-client-id","%s",2]]' "${path}" "${path}")"
  expect_policy_scan "Hono: both approved ids remain detected at ${path}" "${hono_policy}" 1 "${expected}"
done

# -- candidate parity fixture: exact rule/path/value, including new SHAs -------
# Read the candidate policy, so broadening it makes the negative controls fail.
parity_policy="${here}/../../.gitleaks.toml"
parity_path="test/mcp-rest-parity-acceptance.test.ts"
# Build fixture values at run time so the self-test adds no scannable literals.
parity_ulid="$(printf '%s' 01B RZ3NDEKTSV4RRFFQ69G5FAV)"
plant_parity_ulid() {
  mkdir -p "${repo}/$(dirname "$1")"
  printf 'const UNKNOWN_KEY = "%s";\n' "${parity_ulid}" > "${repo}/$1"
}
new_repo parity-approved
plant_parity_ulid "${parity_path}"
base_commit
expect_policy_scan "parity: stock detects the unknown-event fixture" "${work}/stock.toml" 1 \
  '[["generic-api-key","test/mcp-rest-parity-acceptance.test.ts",1]]'
expect_policy_scan "parity: candidate excludes only the approved fixture" "${parity_policy}" 0 '[]'
# A commit-bound fingerprint would fail here and after a squash merge.
printf '\nconst UNKNOWN_KEY = "%s";\n' "${parity_ulid}" > "${repo}/${parity_path}"
pr_commit
expect_policy_scan "parity: exception survives a new commit and line number" "${parity_policy}" 0 '[]'

new_repo parity-other-secrets
mkdir -p "${repo}/test"
printf 'api_key = "%s"\nvalue = "%s"\nconst UNKNOWN_KEY = "%sX";\n' \
  "$(printf 'parity negative-control fixture' | sha256sum | cut -c1-32 | base64 -w0)" "${token}" "${parity_ulid}" \
  > "${repo}/${parity_path}"
base_commit
expect_policy_scan "parity: other values, longer values and another secret rule remain detected" \
  "${parity_policy}" 1 \
  '[["generic-api-key","test/mcp-rest-parity-acceptance.test.ts",1],["github-pat","test/mcp-rest-parity-acceptance.test.ts",2],["generic-api-key","test/mcp-rest-parity-acceptance.test.ts",3]]'

for path in \
  test/other.test.ts \
  nested/test/mcp-rest-parity-acceptance.test.ts \
  test/mcp-rest-parity-acceptance.test.ts.bak \
  test/mcp-rest-parity-acceptanceXtest.ts \
  test/mcp-rest-parity-acceptance.testXts; do
  new_repo "parity-path-${cases}"
  plant_parity_ulid "${path}"
  base_commit
  expected="$(printf '[["generic-api-key","%s",1]]' "${path}")"
  expect_policy_scan "parity: approved value remains detected at ${path}" "${parity_policy}" 1 "${expected}"
done

printf '\n%d cases, %d failed\n' "${cases}" "${failures}"
[[ "${failures}" -eq 0 ]]
