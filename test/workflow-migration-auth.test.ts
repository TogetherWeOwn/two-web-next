import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repository = "fixtures/private";
const token = "synthetic-migration-fixture";
const authorization = `basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const steps = [
  {
    file: "ci.yml",
    name: "Migration numbering check",
    events: ["pull_request", "push", "workflow_dispatch"],
  },
  { file: "db-migrate.yml", name: "Validate migration numbering", events: ["workflow_dispatch"] },
];

function migrationStep(file: string, name: string) {
  const text = readFileSync(`.github/workflows/${file}`, "utf8");
  const step = text
    .split(/(?=^      - )/m)
    .find((part) => part.startsWith(`      - name: ${name}\n`));
  if (!step) throw new Error(`missing migration step: ${file}`);
  const script = step.split("        run: |\n")[1];
  if (!script) throw new Error(`missing migration command: ${file}`);
  return {
    text,
    step,
    // Container jobs default to sh, not Bash. Exercise the workflow's choice.
    shell: step.match(/^        shell: (\S+)\s*$/m)?.[1] ?? "sh",
    script: script
      .split("\n")
      .filter((line) => line.startsWith("          "))
      .map((line) => line.slice(10))
      .join("\n"),
  };
}

let root: string;
let source: string;
let origin: string;
let base: string;
let authenticated = 0;
let refused = 0;
let serial = 0;
const server = createServer((request, response) => {
  if (request.headers.authorization !== authorization) {
    refused += 1;
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
    response.end();
    return;
  }
  authenticated += 1;
  const url = new URL(request.url ?? "/", origin);
  // Like GitHub, serve a repository with or without its `.git` suffix.
  const pathInfo = url.pathname.replace(/^(\/[^/]+\/[^/]+?)(?:\.git)?(\/.*)$/, "$1.git$2");
  const backend = spawn("git", ["http-backend"], {
    env: {
      ...gitEnv(),
      GIT_PROJECT_ROOT: join(root, "remotes"),
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathInfo,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: request.headers["content-length"] ?? "",
      HTTP_GIT_PROTOCOL:
        typeof request.headers["git-protocol"] === "string" ? request.headers["git-protocol"] : "",
      REMOTE_USER: "fixture",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  backend.stderr.resume();
  backend.on("error", () => {
    response.writeHead(500);
    response.end();
  });
  backend.on("close", () => {
    if (response.writableEnded) return;
    const bytes = Buffer.concat(chunks);
    const at = bytes.indexOf("\r\n\r\n");
    if (at < 0) {
      response.writeHead(500);
      response.end();
      return;
    }
    for (const line of bytes.subarray(0, at).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (key === "Status") response.statusCode = Number(value.split(" ")[0]);
      else response.setHeader(key, value);
    }
    response.end(bytes.subarray(at + 4));
  });
  request.pipe(backend.stdin);
});

function gitEnv(): NodeJS.ProcessEnv {
  // Isolate fixtures from credential helpers and the runner's real tokens.
  return {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    PAPERCLIP_SCRATCH_DIR: root,
  };
}

async function git(cwd: string, ...args: string[]) {
  return (
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd,
      env: gitEnv(),
    })
  ).stdout.trim();
}

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "migration-auth-"));
  source = join(root, "source");
  mkdirSync(source);
  await git(source, "init", "-q", "--initial-branch=main");
  for (const file of [
    "check-migration-history.mjs",
    "check-migration-numbers.sh",
    "check-migration-history-selftest.mjs",
  ]) {
    mkdirSync(join(source, "ci"), { recursive: true });
    copyFileSync(`ci/${file}`, join(source, "ci", file));
  }
  const migrations: { path: string; sha256: string }[] = [];
  for (const [number, sql] of [
    [1000, "SELECT 1;\n"],
    [1001, "SELECT 2;\n"],
  ] as const) {
    const path = `drizzle/${number}_fixture.sql`;
    put(join(source, path), sql);
    migrations.push({ path, sha256: createHash("sha256").update(sql).digest("hex") });
    put(
      join(source, "migrations.lock"),
      `${JSON.stringify({ version: 1, migrations }, null, 2)}\n`,
    );
    await git(source, "add", ".");
    await git(source, "commit", "-qm", "fixture migration");
    if (number === 1000) base = await git(source, "rev-parse", "HEAD");
  }
  mkdirSync(join(root, "remotes", "fixtures"), { recursive: true });
  const remote = join(root, "remotes", `${repository}.git`);
  await git(root, "clone", "--bare", source, remote);
  // Like GitHub, serve the event's reachable base SHA even when it is not a tip.
  await git(remote, "config", "uploadpack.allowReachableSHA1InWant", "true");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  origin = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (root) rmSync(root, { recursive: true, force: true });
});

// actions/checkout writes `origin` as `<server>/<owner>/<repo>` with no `.git`.
async function fixture(event: string, suffix: "" | ".git" = "") {
  const checkout = join(root, `checkout-${serial++}`);
  await git(root, "clone", "--depth=1", `file://${source}`, checkout);
  await git(checkout, "remote", "set-url", "origin", `${origin}/${repository}${suffix}`);
  const eventPath = join(checkout, "event.json");
  put(
    eventPath,
    JSON.stringify(
      event === "pull_request" ? { pull_request: { base: { sha: base } } } : { before: base },
    ),
  );
  return {
    checkout,
    env: {
      ...gitEnv(),
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: origin,
      GITHUB_REPOSITORY: repository,
    },
  };
}

async function expectAuthenticatedBaseline(
  file: string,
  name: string,
  event: string,
  suffix: "" | ".git",
) {
  const { checkout, env } = await fixture(event, suffix);
  const config = readFileSync(join(checkout, ".git/config"), "utf8");
  const rejectedBefore = refused;
  const negative = await exec("bash", ["ci/check-migration-numbers.sh"], {
    cwd: checkout,
    env,
  }).then(
    () => "unexpected success",
    (error: { stderr: string }) => error.stderr,
  );
  expect(negative).toContain("cannot read Git baseline (fetch)");
  expect(refused).toBeGreaterThan(rejectedBefore);
  const authenticatedBefore = authenticated;
  const migration = migrationStep(file, name);
  const result = await exec(migration.shell, ["-e", "-c", migration.script], {
    cwd: checkout,
    env: { ...env, MIGRATION_GIT_TOKEN: token },
  });
  expect(result.stdout).toContain("migration-history: ok");
  expect(authenticated).toBeGreaterThan(authenticatedBefore);
  expect(readFileSync(join(checkout, ".git/config"), "utf8")).toBe(config);
  expect(await git(checkout, "config", "--local", "--list")).not.toContain("extraheader");
  const nextStep = await exec(
    "bash",
    [
      "-c",
      'test -z "${MIGRATION_GIT_TOKEN:-}${GIT_CONFIG_COUNT:-}${GIT_CONFIG_VALUE_0:-}${GIT_CONFIG_VALUE_1:-}"',
    ],
    { cwd: checkout, env },
  );
  expect(nextStep.stderr).toBe("");
}

describe("migration workflow fetch authentication", () => {
  for (const { file, name, events } of steps) {
    it(`${file} explicitly selects Bash for the pipefail wrapper`, () => {
      expect(migrationStep(file, name).shell).toBe("bash");
    });

    it(`${file} exposes the token only to the baseline-check step`, () => {
      const { text, step } = migrationStep(file, name);
      expect(step).toContain("        env:\n          MIGRATION_GIT_TOKEN: ${{ github.token }}\n");
      expect(text.replace(step, "")).not.toContain("MIGRATION_GIT_TOKEN");
      expect(step).not.toMatch(/git config|GITHUB_ENV|npm /);
      expect(step).toContain('echo "::add-mask::$auth"');
    });

    for (const event of events) {
      it(`${file}: ${event} fetches an authenticated baseline without persisting credentials`, async () => {
        await expectAuthenticatedBaseline(file, name, event, "");
      }, 45000);
    }

    // A remote configured with an explicit `.git` suffix must authenticate too.
    it(`${file}: a .git-suffixed origin fetches an authenticated baseline`, async () => {
      await expectAuthenticatedBaseline(file, name, "workflow_dispatch", ".git");
    }, 45000);
  }

  for (const other of ["fixtures/other", "fixtures/other.git", "fixtures/private-sibling"]) {
    it(`does not send the command's header to ${other}`, async () => {
      const { checkout, env } = await fixture("workflow_dispatch");
      await git(checkout, "remote", "set-url", "origin", `${origin}/${other}`);
      const authenticatedBefore = authenticated;
      const rejectedBefore = refused;
      const migration = migrationStep("db-migrate.yml", "Validate migration numbering");
      const result = await exec(migration.shell, ["-e", "-c", migration.script], {
        cwd: checkout,
        env: { ...env, MIGRATION_GIT_TOKEN: token },
      }).then(
        () => "unexpected success",
        (error: { stderr: string }) => error.stderr,
      );
      expect(result).toContain("cannot read Git baseline (fetch)");
      expect(authenticated).toBe(authenticatedBefore);
      expect(refused).toBeGreaterThan(rejectedBefore);
    });
  }
});
