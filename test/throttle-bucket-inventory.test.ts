// Throttle bucket inventory: pins every human-route throttle bucket name to
// its registration files so a move without a docs+test update fails loudly.
// Static scan only, DB-free. Covers stale file pointers in
// docs/throttling.md (logout/event-write/qa-login), the missing admin-write
// row, the RSVP contracts move, and the MCP cap-before-throttle order.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "src");
const throttlingDoc = readFileSync(resolve(root, "docs/throttling.md"), "utf8");
const bodyLimitsDoc = readFileSync(resolve(root, "docs/body-limits.md"), "utf8");

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

function stripComments(text: string): string {
  // Parse comment ranges so wildcard strings, templates, regexes and JSX cannot
  // swallow registrations. Blank only comments; preserve tokens and line breaks.
  const { comments } = parse(text, { sourceType: "module", plugins: ["typescript", "jsx"] });
  let out = "";
  let cursor = 0;
  for (const { start, end } of comments ?? []) {
    if (start === undefined || end === undefined) throw new Error("Comment source range missing");
    out += text.slice(cursor, start);
    out += text.slice(start, end).replace(/[^\r\n]/g, " ");
    cursor = end;
  }
  return out + text.slice(cursor);
}

function mcpAdmissionOffsets(source: string): { capAt: number; admitAt: number } {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const statements = ast.program.body.flatMap((node) =>
    node.type === "ExportNamedDeclaration" &&
    node.declaration?.type === "FunctionDeclaration" &&
    node.declaration.id?.name === "registerMcpRoutes"
      ? node.declaration.body.body
      : [],
  );
  const posts = statements.flatMap((node) =>
    node.type === "ExpressionStatement" &&
    node.expression.type === "CallExpression" &&
    node.expression.callee.type === "MemberExpression" &&
    node.expression.callee.object.type === "Identifier" &&
    node.expression.callee.object.name === "app" &&
    !node.expression.callee.computed &&
    node.expression.callee.property.type === "Identifier" &&
    node.expression.callee.property.name === "post" &&
    node.expression.arguments[0]?.type === "StringLiteral" &&
    node.expression.arguments[0].value === "/mcp"
      ? [node.expression]
      : [],
  );
  if (posts.length !== 1) throw new Error("Expected one POST /mcp registration");
  const post = posts[0]!;
  const cap = post.arguments.find(
    (arg) =>
      arg.type === "CallExpression" &&
      arg.callee.type === "Identifier" &&
      arg.callee.name === "requestBodyLimit" &&
      arg.arguments[0]?.type === "StringLiteral" &&
      arg.arguments[0].value === "mcp",
  );
  const callback = post.arguments.find((arg) => arg.type === "ArrowFunctionExpression");
  if (callback?.type !== "ArrowFunctionExpression" || callback.body.type !== "BlockStatement") {
    throw new Error("Expected an inline POST /mcp callback");
  }
  // Inspect executed initializers in this callback, not an earlier helper
  // declaration, comment, string or an uncalled nested function.
  const admission = callback.body.body
    .flatMap((node) =>
      node.type === "VariableDeclaration" ? node.declarations.map((decl) => decl.init) : [],
    )
    .map((init) => (init?.type === "AwaitExpression" ? init.argument : init))
    .find(
      (init) =>
        init?.type === "CallExpression" &&
        init.callee.type === "Identifier" &&
        (init.callee.name === "admitted" || init.callee.name === "mcpRefused") &&
        init.arguments[0]?.type === "Identifier" &&
        init.arguments[0].name === "c",
    );
  return { capAt: cap?.start ?? -1, admitAt: admission?.start ?? -1 };
}

// Middleware registrations: throttle("bucket", N). Excludes src/throttle.ts
// itself (definition + doc comment example).
function middlewareBuckets(): Map<string, { file: string; count: number }[]> {
  const byBucket = new Map<string, Map<string, number>>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    if (rel === "src/throttle.ts") continue;
    const text = stripComments(readFileSync(full, "utf8"));
    for (const match of text.matchAll(/\bthrottle\(\s*"([^"]+)"\s*,/g)) {
      const bucket = match[1]!;
      if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
      const perFile = byBucket.get(bucket)!;
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
    }
  }
  const out = new Map<string, { file: string; count: number }[]>();
  for (const [bucket, perFile] of byBucket) {
    out.set(
      bucket,
      [...perFile]
        .map(([file, count]) => ({ file, count }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    );
  }
  return out;
}

// In-handler guards: throttleGuard(c, "bucket", N). The definition in
// src/throttle.ts takes a variable name, so it never matches.
function guardBuckets(): Map<string, string[]> {
  const byBucket = new Map<string, Set<string>>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    const text = stripComments(readFileSync(full, "utf8"));
    for (const match of text.matchAll(/\bthrottleGuard\(\s*c\s*,\s*"([^"]+)"\s*,/g)) {
      const bucket = match[1]!;
      if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
      byBucket.get(bucket)!.add(rel);
    }
  }
  const out = new Map<string, string[]>();
  for (const [bucket, files] of byBucket) out.set(bucket, [...files].sort());
  return out;
}

// Call sites the literal scanners above cannot see: every throttle(/throttleGuard(
// occurrence whose bucket is not a string literal (or whose guard context is not
// `c`). A const-form or renamed-context registration lands here and fails the
// pins test until it is hand-pinned with a dedicated assertion, so new buckets
// cannot silently escape the inventory (precedent: JOIN_THROTTLE_BUCKET in
// src/join/service.ts). src/throttle.ts is excluded: it holds the definitions
// and the middleware's internal throttleGuard(c, name, max) delegation.
function nonLiteralThrottleSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    if (rel === "src/throttle.ts") continue;
    const text = stripComments(readFileSync(full, "utf8"));
    for (const call of text.matchAll(/\bthrottle\(/g)) {
      if (!/^throttle\(\s*"[^"]+"\s*,/.test(text.slice(call.index))) {
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function nonLiteralGuardSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const full of srcFiles()) {
    const rel = full.slice(root.length + 1);
    if (rel === "src/throttle.ts") continue;
    const text = stripComments(readFileSync(full, "utf8"));
    for (const call of text.matchAll(/\bthrottleGuard\(/g)) {
      if (!/^throttleGuard\(\s*c\s*,\s*"[^"]+"\s*,/.test(text.slice(call.index))) {
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe("inventory comment stripping", () => {
  it.each([
    'const path = "/probe/*";',
    "const path = '/probe/*';",
    "const path = `/probe/*`;",
    'const path = `/probe/${"/*"}/${throttleGuard(ctx, "nested-guard", 1)}`;',
    'const path = "escaped \\" /* https://example.test/*";',
    "const path = /[/*]+/;",
    'const path = <div title="/probe/*">{/* jsx-only */}</div>;',
  ])("preserves literals and registrations after %s", (prefix) => {
    const registrations = [
      'throttle("hidden-bucket", 1);',
      'throttleGuard(c, "hidden-guard", 1);',
      "throttle(BUCKET, 1);",
      'throttleGuard(ctx, "renamed-context", 1);',
    ].join("\n");
    const stripped = stripComments(`${prefix}\n${registrations}\n/* trailing-only */`);
    expect(stripped).toContain(registrations);
    expect(stripped).toContain(prefix.replace("{/* jsx-only */}", "{              }"));
    expect(stripped).not.toContain("trailing-only");
  });

  it("removes real comments without merging tokens or consuming later code", () => {
    const stripped = stripComments(
      [
        '/* throttle("block-only", 1); */',
        'const path = "/probe/*";// throttle("line-only", 1);',
        'const url = "https://example.test/*";',
        'throttle(/* argument-only */ "visible", 1);',
        'const path2 = `/probe/${/* interpolation-only */ "*"}`;',
        "const first = 1;/* separator-only */const second = 2;",
        'throttleGuard(c, "visible-guard", 1);',
      ].join("\n"),
    );
    for (const comment of [
      "block-only",
      "line-only",
      "argument-only",
      "interpolation-only",
      "separator-only",
    ]) {
      expect(stripped).not.toContain(comment);
    }
    expect(stripped).toContain('const path = "/probe/*";');
    expect(stripped).toContain('const url = "https://example.test/*";');
    expect(stripped).toMatch(/throttle\(\s+"visible", 1\);/);
    expect(stripped).toMatch(/1;\s+const second/);
    expect(stripped).toContain('throttleGuard(c, "visible-guard", 1);');
  });
});

describe.each(["admitted", "mcpRefused"])("MCP admission order via %s", (helper) => {
  const prefix = `async function ${helper}(c) { return admissionRetryAfter(c); }`;
  const register = (args: string) =>
    `${prefix}\nexport function registerMcpRoutes(app) { app.post("/mcp", ${args}); }`;
  const callback = `async (c) => { const refused = await ${helper}(c); return refused; }`;

  it("finds the actual callback call after the cap, not the earlier definition", () => {
    const source = register(`requestBodyLimit("mcp"), ${callback}`);
    const { capAt, admitAt } = mcpAdmissionOffsets(source);
    expect(capAt).toBe(source.indexOf('requestBodyLimit("mcp")'));
    expect(admitAt).toBe(source.lastIndexOf(`${helper}(c)`));
    expect(capAt).toBeLessThan(admitAt);
  });

  it("rejects the inverted middleware order", () => {
    const { capAt, admitAt } = mcpAdmissionOffsets(
      register(`${callback}, requestBodyLimit("mcp")`),
    );
    expect(capAt).toBeGreaterThanOrEqual(0);
    expect(admitAt).toBeGreaterThanOrEqual(0);
    expect(capAt).toBeGreaterThan(admitAt);
  });

  it("rejects a cap moved into the callback after admission", () => {
    const { capAt, admitAt } = mcpAdmissionOffsets(
      register(`async (c) => {
        const refused = await ${helper}(c);
        await requestBodyLimit("mcp")(c, async () => {});
        return refused;
      }`),
    );
    expect(capAt).toBe(-1);
    expect(admitAt).toBeGreaterThanOrEqual(0);
  });

  it("does not treat definitions, comments, strings or nested callbacks as admission", () => {
    const { capAt, admitAt } = mcpAdmissionOffsets(
      register(`requestBodyLimit("mcp"), async (c) => {
        // ${helper}(c)
        const example = "${helper}(c)";
        const unused = async () => ${helper}(c);
        return example;
      }`),
    );
    expect(capAt).toBeGreaterThanOrEqual(0);
    expect(admitAt).toBe(-1);
  });
});

describe("throttle bucket inventory", () => {
  it("pins middleware buckets to their registration files and counts", () => {
    const found = middlewareBuckets();
    const expected = new Map<string, { file: string; count: number }[]>([
      ["admin-write", [{ file: "src/admin/routes.tsx", count: 8 }]],
      ["event-write", [{ file: "src/events/routes-writes.ts", count: 4 }]],
      ["logout", [{ file: "src/auth/routes.ts", count: 1 }]],
      ["qa-login", [{ file: "src/auth/routes.ts", count: 1 }]],
      ["alert-probe", [{ file: "src/alert-probe.ts", count: 1 }]],
    ]);
    expect([...found.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [bucket, sites] of expected) {
      expect(found.get(bucket), `bucket ${bucket}`).toEqual(sites);
    }
  });

  it("pins in-handler guard buckets to their call sites", () => {
    const found = guardBuckets();
    expect([...found.keys()].sort()).toEqual([
      "events-read",
      "login-callback",
      "login-recover",
      "login-redirect",
    ]);
    expect(found.get("login-redirect")).toEqual(["src/auth/routes.ts"]);
    expect(found.get("login-callback")).toEqual(["src/auth/routes.ts"]);
    expect(found.get("login-recover")).toEqual(["src/write-recovery.tsx"]);
    expect(found.get("events-read")).toEqual(["src/events/routes-shared.ts"]);
  });

  it("fails loudly on non-literal throttle registrations", () => {
    // src/profiles/routes-admission.ts holds the only two: the local admitWrite
    // helper call throttle(c, `profile-write:${viewer.id}`) and the
    // deps.throttle(bucket) seam delegation. Neither is the src/throttle.ts
    // middleware; the profile-write bucket itself is pinned by the dedicated
    // assertion below. Any new entry here is a bucket escaping the literal
    // inventory: hand-pin it and cover it, or make it literal.
    expect(Object.fromEntries(nonLiteralThrottleSites())).toEqual({
      "src/profiles/routes-admission.ts": 2,
    });
    expect(Object.fromEntries(nonLiteralGuardSites())).toEqual({});
  });

  it("pins join, profile-write and rsvp-write buckets to their call sites", () => {
    const service = stripComments(readFileSync(resolve(root, "src/join/service.ts"), "utf8"));
    expect(service).toContain('JOIN_THROTTLE_BUCKET = "join"');
    const routeShared = stripComments(
      readFileSync(resolve(root, "src/join/route-shared.ts"), "utf8"),
    );
    expect(routeShared).toContain("${JOIN_THROTTLE_BUCKET}:");
    const admission = stripComments(
      readFileSync(resolve(root, "src/profiles/routes-admission.ts"), "utf8"),
    );
    expect(admission).toContain("profile-write:${viewer.id}");
    const rsvp = stripComments(readFileSync(resolve(root, "src/events/rsvp.ts"), "utf8"));
    expect(rsvp.match(/rsvp-write:/g)?.length).toBe(3);
  });

  it("documents every bucket in docs/throttling.md with live file pointers", () => {
    // Discovered buckets: a new registration whose pins were updated but whose
    // docs row was forgotten fails here. The hard-coded list below stays as the
    // canonical inventory of documented buckets.
    for (const bucket of [
      ...middlewareBuckets().keys(),
      ...guardBuckets().keys(),
      "join",
      "profile-write",
      "rsvp-write",
    ]) {
      expect(throttlingDoc, `docs mention discovered bucket ${bucket}`).toContain(bucket);
    }
    for (const bucket of [
      "login-redirect",
      "login-callback",
      "login-recover",
      "qa-login",
      "alert-probe",
      "join",
      "logout",
      "event-write",
      "admin-write",
      "profile-write",
      "events-read",
      "rsvp-write",
    ]) {
      expect(throttlingDoc, `docs mention ${bucket}`).toContain(bucket);
    }
    for (const file of [
      "src/auth/routes.ts",
      "src/write-recovery.tsx",
      "src/alert-probe.ts",
      "src/join/service.ts",
      "src/join/route-shared.ts",
      "src/events/routes-writes.ts",
      "src/admin/routes.tsx",
      "src/profiles/routes-admission.ts",
      "src/events/routes-shared.ts",
      "src/public-data/routes.ts",
      "src/mcp/routes.ts",
      "src/events/rsvp.ts",
      "src/islands/contracts-rsvp-button.ts",
    ]) {
      expect(throttlingDoc, `docs point at ${file}`).toContain(file);
    }
    // Stale pointers from the pre-split layout must not return.
    expect(throttlingDoc).not.toContain("src/index.tsx");
    expect(throttlingDoc).not.toContain("src/events/routes.tsx");
    expect(throttlingDoc).not.toContain("src/islands/contracts.ts");
    // Admin-write row lists its routes and the shared-budget implication.
    expect(throttlingDoc).toContain("POST /admin/featured");
    expect(throttlingDoc).toContain("POST /admin/events");
    expect(throttlingDoc).toContain("POST /admin/queue/failed/:id/redispatch");
  });

  it("pins each bucket to its registration file in its own table row", () => {
    // Row-scoped association: whole-document co-occurrence would let any row
    // point at any already-mentioned file, so each bucket's table row must name
    // the file holding that bucket's registration. Expected files come from the
    // same scanned maps as the pins tests (plus the hand-pinned buckets) so
    // code, pins and docs cannot drift in pairs.
    const bucketFiles = new Map<string, string[]>([
      ["join", ["src/join/service.ts", "src/join/route-shared.ts"]],
      ["profile-write", ["src/profiles/routes-admission.ts", "src/profiles/routes-writes.tsx"]],
      ["rsvp-write", ["src/events/rsvp.ts"]],
    ]);
    for (const [bucket, sites] of middlewareBuckets()) {
      bucketFiles.set(
        bucket,
        sites.map((s) => s.file),
      );
    }
    for (const [bucket, files] of guardBuckets()) {
      bucketFiles.set(bucket, files);
    }
    const rows = throttlingDoc.split("\n").filter((line) => line.startsWith("|"));
    for (const [bucket, files] of bucketFiles) {
      const hits = rows.filter((row) => row.includes(`\`${bucket}`));
      expect(hits.length, `docs table rows mentioning \`${bucket}`).toBeGreaterThan(0);
      for (const row of hits) {
        for (const file of files) {
          expect(row, `\`${bucket}\` row points at ${file}`).toContain(file);
        }
      }
    }
    // Multi-bucket rows need clause-level pins: the Auth and Write rows each
    // name two registration files, so row scope alone cannot say which bucket
    // belongs to which file.
    for (const clause of [
      "`login-redirect` (`GET /auth/discord`), `login-callback` (`GET /auth/discord/callback`), `qa-login` (`POST /auth/qa/:identity`) in [`src/auth/routes.ts`](../src/auth/routes.ts)",
      "`alert-probe` in [`src/alert-probe.ts`](../src/alert-probe.ts)",
      "`logout` (`POST /logout`) in [`src/auth/routes.ts`](../src/auth/routes.ts)",
      "`event-write` on `POST /events`, `PATCH /events/:key` and `POST /events/:key/{publish,cancel,duplicate,rsvp-pause,rsvp-reopen}` in [`src/events/routes-writes.ts`](../src/events/routes-writes.ts)",
    ]) {
      expect(throttlingDoc, `docs pin ${clause.slice(0, 48)}...`).toContain(clause);
    }
  });

  it("documents the MCP cap-before-throttle order in docs/body-limits.md", () => {
    expect(bodyLimitsDoc).toContain("POST /mcp");
    expect(bodyLimitsDoc).toContain("src/mcp/routes.ts");
    const { capAt, admitAt } = mcpAdmissionOffsets(
      readFileSync(resolve(root, "src/mcp/routes.ts"), "utf8"),
    );
    expect(capAt).toBeGreaterThanOrEqual(0);
    expect(admitAt).toBeGreaterThanOrEqual(0);
    expect(capAt).toBeLessThan(admitAt);
  });

  it("every src/ pointer in both docs resolves to an existing file", () => {
    for (const [name, doc] of [
      ["docs/throttling.md", throttlingDoc],
      ["docs/body-limits.md", bodyLimitsDoc],
    ] as const) {
      const pointers = new Set<string>();
      for (const match of doc.matchAll(/src\/[A-Za-z0-9._/-]+\.(?:tsx?|md)/g)) {
        pointers.add(match[0]);
      }
      expect(pointers.size, `${name} has src pointers`).toBeGreaterThan(0);
      for (const pointer of pointers) {
        expect(existsSync(resolve(root, pointer)), `${name} pointer ${pointer}`).toBe(true);
      }
    }
  });
});
