import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMachineContractFixture } from "./machine-contract-fixture";

const repo = fileURLToPath(new URL("../", import.meta.url));
const guide = readFileSync(join(repo, "docs/machine-interface.md"), "utf8");
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.includes("DATABASE_URL") || name.startsWith("PG")) delete env[name];
}

describe("compiled machine contract fixture", () => {
  let root: string;
  let checker: string;
  let schema: string;
  let originalSchema: string;
  beforeAll(() => {
    root = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "machine-bundle-equivalence-"),
    );
    for (const dir of ["ci", "src"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
    mkdirSync(join(root, "docs"));
    for (const file of ["package.json", "tsconfig.json"])
      copyFileSync(join(repo, file), join(root, file));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
    checker = join(root, "ci/check-machine-contract.mjs");
    copyFileSync(checker, join(root, "ci/source-machine-contract.mjs"));
    schema = join(root, "src/mcp/output-schemas.ts");
    originalSchema = readFileSync(schema, "utf8");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function compare(expectedStatus: number) {
    const options = {
      cwd: root,
      env,
      encoding: "utf8" as const,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    };
    const source = spawnSync(
      process.execPath,
      ["--import", "tsx", "ci/source-machine-contract.mjs", "--format", "json"],
      options,
    );
    const bundle = spawnSync(
      process.execPath,
      ["ci/check-machine-contract.mjs", "--format", "json"],
      options,
    );
    expect(source.error).toBeUndefined();
    expect(bundle.error).toBeUndefined();
    expect(source.status).toBe(expectedStatus);
    expect({ status: bundle.status, stdout: bundle.stdout, stderr: bundle.stderr }).toEqual({
      status: source.status,
      stdout: source.stdout,
      stderr: source.stderr,
    });
  }

  it("preserves canonical, invalid and hidden Markdown guide results", () => {
    compileMachineContractFixture(root);
    for (const [text, status] of [
      [guide, 0],
      [`${guide}\nEvent collection responses contain 30 rows-per-response.\n`, 1],
      [`${guide}\n<!-- Event collection responses contain 30 rows-per-response. -->\n`, 0],
      [
        `${guide}\n| Info | Note |\n| --- | --- |\n| Stuff | Each [response][ref] contains 30 rows per response. |\n\n[ref]: https://example.test/\n`,
        1,
      ],
    ] as const) {
      writeFileSync(join(root, "docs/machine-interface.md"), text);
      compare(status);
    }
  });

  it("rebuilds actual changed schemas and preserves their failure receipt", () => {
    const marker = "  title: z.string(),";
    expect(originalSchema).toContain(marker);
    writeFileSync(schema, originalSchema.replace(marker, "  title: z.number(),"));
    copyFileSync(join(root, "ci/source-machine-contract.mjs"), checker);
    compileMachineContractFixture(root);
    writeFileSync(join(root, "docs/machine-interface.md"), guide);
    compare(1);
    writeFileSync(schema, originalSchema);
  });

  it("refuses new source location or cwd dependencies without overwriting the checker", () => {
    for (const probe of ["void import.meta.url;", "process.cwd();", "void __dirname;"]) {
      writeFileSync(schema, `${originalSchema}\n${probe}\n`);
      copyFileSync(join(root, "ci/source-machine-contract.mjs"), checker);
      const before = readFileSync(checker, "utf8");
      expect(() => compileMachineContractFixture(root)).toThrow(/Unsupported/);
      expect(readFileSync(checker, "utf8")).toBe(before);
    }
    writeFileSync(schema, originalSchema);
    const source = readFileSync(join(root, "ci/source-machine-contract.mjs"), "utf8");
    const changedRoot = source.replace(
      'new URL("../", import.meta.url)',
      'new URL("../../", import.meta.url)',
    );
    expect(changedRoot).not.toBe(source);
    writeFileSync(checker, changedRoot);
    expect(() => compileMachineContractFixture(root)).toThrow(/Unsupported/);
    expect(readFileSync(checker, "utf8")).toBe(changedRoot);
  });

  it("checks bundled package inputs while accepting JSON data and new.target", () => {
    const dependency = join(root, "fixtures/node_modules/guard-probe");
    mkdirSync(dependency, { recursive: true });
    const module = join(dependency, "index.mjs");
    writeFileSync(
      join(dependency, "data.json"),
      JSON.stringify({ ok: true, text: "import.meta.url __dirname process.cwd()" }),
    );
    writeFileSync(
      schema,
      `${originalSchema}\nimport "../../fixtures/node_modules/guard-probe/index.mjs";\n`,
    );
    const safe = `import data from "./data.json";
if (!data.ok) throw new Error("JSON data was not bundled");
export function probe() { return new.target; }
`;
    writeFileSync(module, safe);
    copyFileSync(join(root, "ci/source-machine-contract.mjs"), checker);
    writeFileSync(join(root, "docs/machine-interface.md"), guide);
    compileMachineContractFixture(root);
    const result = spawnSync(
      process.execPath,
      ["ci/check-machine-contract.mjs", "--format", "json"],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
    expect(result.stderr).toBe("");

    for (const probe of [
      "void import.meta.url;",
      "process.cwd();",
      "void __dirname;",
      "void __filename;",
    ]) {
      writeFileSync(module, `${safe}\n${probe}\n`);
      copyFileSync(join(root, "ci/source-machine-contract.mjs"), checker);
      const before = readFileSync(checker, "utf8");
      expect(() => compileMachineContractFixture(root)).toThrow(/Unsupported/);
      expect(readFileSync(checker, "utf8")).toBe(before);
    }
    writeFileSync(schema, originalSchema);
  });

  it("preserves real modern SDK client interaction with a bundled server", () => {
    writeFileSync(schema, originalSchema);
    const serverEntry = join(root, "ci/sdk-server-entry.mjs");
    const serverBundle = join(root, "ci/sdk-server-bundle.mjs");
    writeFileSync(serverEntry, 'export { createPublicMcpServer } from "../src/mcp/server";\n');
    buildSync({
      absWorkingDir: root,
      entryPoints: [serverEntry],
      outfile: serverBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent",
    });
    const client = `import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createPublicMcpServer } from "SERVER_MODULE";
const server = createPublicMcpServer({ env: { APP_URL: "https://machine-contract-check.local", DISCORD_INVITE_URL: "https://discord.gg/machine-contract-check" }, db: null });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const sdk = new Client({ name: "fixture-client", version: "0" }, { capabilities: {} });
await server.connect(serverTransport);
await sdk.connect(clientTransport);
const tools = await sdk.listTools();
const result = await sdk.callTool({ name: "get_join", arguments: {} });
console.log(JSON.stringify({ version: sdk.getServerVersion(), tools, result }));
await sdk.close();
await server.close();
`;
    const sourceClient = join(root, "ci/sdk-client-source.mjs");
    const bundleClient = join(root, "ci/sdk-client-bundle.mjs");
    writeFileSync(sourceClient, client.replace("SERVER_MODULE", "../src/mcp/server"));
    writeFileSync(bundleClient, client.replace("SERVER_MODULE", "./sdk-server-bundle.mjs"));
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 30_000 };
    const source = spawnSync(process.execPath, ["--import", "tsx", sourceClient], options);
    const bundled = spawnSync(process.execPath, [bundleClient], options);
    expect(source.error).toBeUndefined();
    expect(bundled.error).toBeUndefined();
    expect(source.status, source.stderr).toBe(0);
    expect({ status: bundled.status, stdout: bundled.stdout, stderr: bundled.stderr }).toEqual({
      status: source.status,
      stdout: source.stdout,
      stderr: source.stderr,
    });
    const output = JSON.parse(bundled.stdout);
    expect(output.tools.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "get_community",
      "get_event",
      "get_join",
      "list_events",
    ]);
    expect(output.result.structuredContent.invite_url).toBe(
      "https://discord.gg/machine-contract-check",
    );
    expect(JSON.parse(output.result.content[0].text)).toEqual(output.result.structuredContent);
  });
});
