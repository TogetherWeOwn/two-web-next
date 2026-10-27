// Deploy identity CLI shared by the staging and production lanes (and any
// later lane that needs the same records). Five subcommands, one file:
//
//   stamp   generate src/build-stamp.ts BEFORE the single compile
//   next    allocate the environment-scoped deploy event ID
//   create  create (or reuse) the canonical GitHub Deployment record
//   status  post its truthful final status
//   verify  prove the live Worker answers the identity just recorded
//
// The runtime half lives in src/deploy-identity.ts; the shapes parsed here
// are the same ones, pinned together by test/web-deploy-identity-*.
//
// Posture (the repo gate convention, see ci/production-deploy-gate.mjs):
// `fetch` against api.github.com with a GITHUB_TOKEN bearer, explicit
// `per_page`/`page` parameters, JSON response bodies only. Output is limited
// to fixed messages and the one result line: upstream bodies, the token and
// input file contents are never echoed. Every failure exits non-zero.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[1-9]\d{0,19}-[1-9]\d{0,19}-[1-9]\d{0,19}$/;
const EVENT_ID = /^(\d{4})\.(\d{2})\.(\d{2})\.([1-9]\d{0,5})\+([0-9a-f]{7})$/;
const DATE = /^(\d{4})\.(\d{2})\.(\d{2})$/;
const ENVIRONMENTS = new Set(["staging", "production"]);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_ID = /^[1-9]\d{0,14}$/;
const VERSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A description that opens like an event ID but is not canonical must fail
// closed instead of being silently left out of the counter.
const CLAIMS_EVENT_ID = /^\d{4}\.\d{1,2}\.\d{1,2}\.\d+(\+|$)/;

const API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 6;
const REQUEST_TIMEOUT_MS = 20_000;

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};

// --- argument handling -------------------------------------------------

const FLAGS = {
  stamp: { values: ["sha", "build-id", "out", "input"], repeatable: ["input"], booleans: [] },
  next: {
    values: ["environment", "sha", "date", "deployments-json", "saved"],
    repeatable: [],
    booleans: [],
  },
  create: {
    values: ["environment", "sha", "deploy-event-id"],
    repeatable: [],
    booleans: ["rollback", "dry-run"],
  },
  status: {
    values: ["deployment-id", "deploy-event-id", "state", "run-url", "environment-url"],
    repeatable: [],
    booleans: ["dry-run"],
  },
  verify: {
    values: ["origin", "sha", "deploy-event-id", "deployment-id", "version-id"],
    repeatable: [],
    booleans: [],
  },
};

function parseArgs(command, argv) {
  const spec = FLAGS[command];
  const out = { values: new Map(), booleans: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) refuse(`unexpected argument for ${command}`);
    const name = token.slice(2);
    if (spec.booleans.includes(name)) {
      if (out.booleans.has(name)) refuse(`duplicate --${name}`);
      out.booleans.add(name);
      continue;
    }
    if (!spec.values.includes(name)) refuse(`unknown option for ${command}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) refuse(`--${name} needs a value`);
    i += 1;
    const list = out.values.get(name) ?? [];
    if (list.length > 0 && !spec.repeatable.includes(name)) refuse(`duplicate --${name}`);
    list.push(value);
    out.values.set(name, list);
  }
  return out;
}

const one = (args, name) => args.values.get(name)?.[0];
const required = (args, name) => one(args, name) ?? refuse(`--${name} is required`);

function requireSha(value) {
  return SHA.test(value) ? value : refuse("--sha must be a full lowercase 40-hex commit");
}

function requireEnvironment(value) {
  return ENVIRONMENTS.has(value) ? value : refuse("--environment must be staging or production");
}

function realDate(year, month, day) {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function parseEventId(value) {
  if (typeof value !== "string") return null;
  const match = EVENT_ID.exec(value);
  if (!match) return null;
  if (!realDate(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
  return {
    date: `${match[1]}.${match[2]}.${match[3]}`,
    sequence: Number(match[4]),
    sha7: match[5],
  };
}

function requireEventId(value, sha) {
  const parsed = parseEventId(value);
  if (!parsed) refuse("--deploy-event-id must be a canonical YYYY.MM.DD.N+sha7 event ID");
  if (sha !== undefined && parsed.sha7 !== sha.slice(0, 7)) {
    refuse("--deploy-event-id suffix must be the first 7 characters of --sha");
  }
  return value;
}

function requireDate(value) {
  const match = DATE.exec(value);
  if (!match || !realDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    refuse("--date must be a real YYYY.MM.DD calendar date");
  }
  return value;
}

function requireHttpsUrl(value, flag) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return refuse(`--${flag} must be an https URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    refuse(`--${flag} must be an https URL without credentials`);
  }
  return value;
}

const utcDateOf = (instant) => instant.toISOString().slice(0, 10).replaceAll("-", ".");

// --- stamp -------------------------------------------------------------

function normalizeInput(raw) {
  if (raw === "" || raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) {
    refuse("--input must be a relative POSIX path");
  }
  const segments = raw.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    refuse("--input must stay inside the working tree");
  }
  return segments.join("/");
}

function stampCommand(args) {
  const sha = requireSha(required(args, "sha"));
  const buildId = required(args, "build-id");
  if (!BUILD_ID.test(buildId)) refuse("--build-id must be <repositoryId>-<runId>-<attempt>");
  const out = required(args, "out");
  const inputs = (args.values.get("input") ?? []).map(normalizeInput);
  if (inputs.length === 0) refuse("at least one --input is required");
  if (new Set(inputs).size !== inputs.length) refuse("duplicate --input");

  const cwd = realpathSync(process.cwd());
  const lines = [];
  // Byte order on the POSIX path, so argument order never matters.
  for (const path of inputs.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    let real;
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) refuse("--input must be a regular file");
      real = realpathSync(path);
    } catch (err) {
      if (err instanceof Refusal) throw err;
      return refuse("--input file is missing or unreadable");
    }
    if (real !== cwd && !real.startsWith(cwd + sep))
      refuse("--input must stay inside the working tree");
    const digest = createHash("sha256").update(readFileSync(real)).digest("hex");
    lines.push(`${digest}  ${path}\n`);
  }
  const inputSetDigest = createHash("sha256").update(lines.join(""), "utf8").digest("hex");
  const text = [
    "// GENERATED by ci/deploy-identity.mjs. Do not edit.",
    "// Build identity compiled into the Worker payload: the source commit, the",
    "// run-derived build ID and the digest of the input set. Deploy lanes",
    "// regenerate this file before the single compile; the per-environment",
    "// deploy event arrives later as Version-scoped runtime bindings.",
    "export const BUILD_STAMP = {",
    `  sourceSha: "${sha}",`,
    `  buildId: "${buildId}",`,
    `  inputSetDigest: "${inputSetDigest}",`,
    "};",
    "",
  ].join("\n");
  writeFileSync(out, text);
  process.stdout.write(`stamped ${sha.slice(0, 7)} ${buildId} ${inputSetDigest.slice(0, 12)}\n`);
}

// --- GitHub transport --------------------------------------------------

function liveContext() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!REPOSITORY.test(repository)) refuse("GITHUB_REPOSITORY is missing or malformed");
  const token = process.env.GITHUB_TOKEN ?? "";
  if (token === "") refuse("GITHUB_TOKEN is missing");
  return { repository, token };
}

async function github(ctx, method, path, body) {
  let res;
  try {
    res = await fetch(`${API}/repos/${ctx.repository}/${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${ctx.token}`,
        "content-type": "application/json",
        "user-agent": "two-web-next-deploy-identity",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return refuse("GitHub request failed");
  }
  if (!res.ok) refuse(`GitHub request failed with HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    return refuse("GitHub response was not JSON");
  }
}

// --- enumeration (bounded, newest first) -------------------------------

function fixturePages(file) {
  let rows;
  try {
    rows = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return refuse("--deployments-json is missing or not JSON");
  }
  if (!Array.isArray(rows)) refuse("--deployments-json must be a JSON array");
  return async (page) => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

function livePages(environment) {
  const ctx = liveContext();
  return async (page) => {
    const rows = await github(
      ctx,
      "GET",
      `deployments?environment=${environment}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(rows)) refuse("GitHub deployments page was not an array");
    return rows;
  };
}

function createdDate(row) {
  if (typeof row.created_at !== "string" || !ZONED_TIMESTAMP.test(row.created_at)) {
    refuse("a Deployment row lacks a zoned created_at");
  }
  const instant = new Date(row.created_at);
  if (Number.isNaN(instant.getTime())) refuse("a Deployment row has an unparseable created_at");
  return utcDateOf(instant);
}

// The event ID a row records, null for an automatic `environment:` job row.
function recordedEventId(row) {
  const { description } = row;
  if (typeof description !== "string" || !CLAIMS_EVENT_ID.test(description)) return null;
  if (!parseEventId(description)) refuse("a Deployment description claims a noncanonical event ID");
  const payload = row.payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.deploy_event_id !== undefined &&
    payload.deploy_event_id !== description
  ) {
    refuse("a Deployment payload event ID disagrees with its description");
  }
  return description;
}

/**
 * Every validated row of the environment created on `date` or later. Rows
 * arrive newest first, but a page is always read and validated whole: the walk
 * ends after the page that holds the first row older than the date, or at a
 * short page, and gives up after six full pages rather than guess (an
 * incomplete count could mint a duplicate).
 */
async function enumerateSince(environment, date, fetchPage) {
  const kept = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await fetchPage(page);
    let reachedOlder = false;
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        refuse("a Deployment row is not an object");
      }
      if (typeof row.environment !== "string") refuse("a Deployment row lacks its environment");
      const day = createdDate(row);
      const eventId = recordedEventId(row);
      if (day < date) reachedOlder = true;
      else if (row.environment === environment) kept.push({ row, day, eventId });
    }
    if (reachedOlder || rows.length < PAGE_SIZE) return kept;
  }
  return refuse("Deployment enumeration is incomplete after six full pages");
}

// --- next --------------------------------------------------------------

function readSaved(path, sha) {
  const text = readFileSync(path, "utf8").trim();
  const parsed = parseEventId(text);
  if (!parsed || parsed.sha7 !== sha.slice(0, 7)) {
    refuse("--saved holds a malformed record or one for another commit");
  }
  return text;
}

async function nextCommand(args) {
  const environment = requireEnvironment(required(args, "environment"));
  const sha = requireSha(required(args, "sha"));
  const date = requireDate(one(args, "date") ?? utcDateOf(new Date()));
  const saved = one(args, "saved");
  if (saved !== undefined && existsSync(saved)) {
    process.stdout.write(`DEPLOY_EVENT_ID=${readSaved(saved, sha)}\n`);
    return;
  }
  const fixture = one(args, "deployments-json");
  const fetchPage = fixture !== undefined ? fixturePages(fixture) : livePages(environment);
  const rows = await enumerateSince(environment, date, fetchPage);
  const sameDay = rows.filter((entry) => entry.day === date && entry.eventId !== null);
  const sequence = sameDay.length + 1;
  if (sequence > 999_999) refuse("the same-day counter is out of range");
  const eventId = `${date}.${sequence}+${sha.slice(0, 7)}`;
  if (saved !== undefined) writeFileSync(saved, `${eventId}\n`);
  process.stdout.write(`DEPLOY_EVENT_ID=${eventId}\n`);
}

// --- create / status ---------------------------------------------------

function createRequest(args) {
  const environment = requireEnvironment(required(args, "environment"));
  const sha = requireSha(required(args, "sha"));
  const eventId = requireEventId(required(args, "deploy-event-id"), sha);
  const payload = { deploy_event_id: eventId };
  if (args.booleans.has("rollback")) payload.rollback = true;
  return {
    environment,
    sha,
    eventId,
    request: {
      ref: sha,
      task: "deploy",
      environment,
      production_environment: environment === "production",
      auto_merge: false,
      required_contexts: [],
      description: eventId,
      payload,
    },
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
    ? value
    : refuse("GitHub returned no usable Deployment ID");
}

async function createCommand(args) {
  const { environment, sha, eventId, request } = createRequest(args);
  if (args.booleans.has("dry-run")) {
    process.stdout.write(`${JSON.stringify({ create: request })}\n`);
    return;
  }
  const ctx = liveContext();
  const eventDate = parseEventId(eventId).date;
  const existing = (await enumerateSince(environment, eventDate, livePages(environment))).filter(
    (entry) => entry.eventId === eventId,
  );
  if (existing.length > 1) refuse("the event ID is bound to more than one Deployment");
  if (existing.length === 1) {
    const [{ row }] = existing;
    if (row.sha !== sha) refuse("the event ID is already bound to a different commit");
    process.stdout.write(`GITHUB_DEPLOYMENT_ID=${positiveInteger(row.id)}\n`);
    return;
  }
  const created = await github(ctx, "POST", "deployments", request);
  const id = positiveInteger(created?.id);
  process.stdout.write(`GITHUB_DEPLOYMENT_ID=${id}\n`);
}

function statusRequest(args) {
  const deploymentId = required(args, "deployment-id");
  if (!POSITIVE_ID.test(deploymentId)) refuse("--deployment-id must be a positive integer");
  const eventId = requireEventId(required(args, "deploy-event-id"));
  const state = required(args, "state");
  if (state !== "success" && state !== "failure") refuse("--state must be success or failure");
  const request = { state, description: eventId };
  const runUrl = one(args, "run-url");
  if (runUrl !== undefined) request.log_url = requireHttpsUrl(runUrl, "run-url");
  const environmentUrl = one(args, "environment-url");
  if (environmentUrl !== undefined) {
    request.environment_url = requireHttpsUrl(environmentUrl, "environment-url");
  }
  return { deploymentId, request };
}

async function statusCommand(args) {
  const { deploymentId, request } = statusRequest(args);
  if (args.booleans.has("dry-run")) {
    process.stdout.write(`${JSON.stringify({ status: request })}\n`);
    return;
  }
  const ctx = liveContext();
  await github(ctx, "POST", `deployments/${deploymentId}/statuses`, request);
  process.stdout.write(`status ${request.state} recorded for Deployment ${deploymentId}\n`);
}

// --- verify ------------------------------------------------------------

const IDENTITY_KEYS = [
  "build_id",
  "cloudflare_version_id",
  "deploy_event_id",
  "github_deployment_id",
  "source_sha",
];

async function verifyCommand(args) {
  const origin = new URL(required(args, "origin"));
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "") {
    refuse("--origin must be an https origin without credentials");
  }
  const sha = requireSha(required(args, "sha"));
  const eventId = requireEventId(required(args, "deploy-event-id"), sha);
  const deploymentId = required(args, "deployment-id");
  if (!POSITIVE_ID.test(deploymentId)) refuse("--deployment-id must be a positive integer");
  const versionId = one(args, "version-id");
  if (versionId !== undefined && !VERSION_UUID.test(versionId)) {
    refuse("--version-id must be a lowercase UUID");
  }
  for (const path of ["/version", "/readyz"]) {
    let body;
    try {
      const res = await fetch(new URL(path, origin), {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status !== 200) refuse(`${path} did not answer 200`);
      body = await res.json();
    } catch (err) {
      if (err instanceof Refusal) throw err;
      return refuse(`${path} could not be read`);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      refuse(`${path} body is not an object`);
    }
    if (Object.keys(body).sort().join() !== IDENTITY_KEYS.join()) {
      refuse(`${path} body is not the fixed identity allowlist`);
    }
    if (
      body.source_sha !== sha ||
      body.deploy_event_id !== eventId ||
      body.github_deployment_id !== deploymentId ||
      typeof body.build_id !== "string" ||
      !BUILD_ID.test(body.build_id) ||
      typeof body.cloudflare_version_id !== "string" ||
      !VERSION_UUID.test(body.cloudflare_version_id) ||
      (versionId !== undefined && body.cloudflare_version_id !== versionId)
    ) {
      refuse(`${path} does not report the recorded deploy identity`);
    }
  }
  process.stdout.write(`verified ${eventId} on ${origin.host}\n`);
}

// --- entry -------------------------------------------------------------

const COMMANDS = {
  stamp: stampCommand,
  next: nextCommand,
  create: createCommand,
  status: statusCommand,
  verify: verifyCommand,
};

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? "")) {
    refuse("usage: deploy-identity.mjs stamp|next|create|status|verify [options]");
  }
  await COMMANDS[command](parseArgs(command, rest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `deploy-identity: ${err instanceof Refusal ? err.message : "unexpected failure"}\n`,
    );
    process.exit(1);
  });
}
