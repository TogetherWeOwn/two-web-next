// Route-parity request matrix (docs/kit-parity-gates.md, "Pure-Hono route
// parity goldens"). buildVectors is pure so ci/parity/parity.test.mjs can pin
// the matrix without a Worker; loadVectorInputs reads the three route sources.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const SAME_ORIGIN = "https://next.togetherweown.com";
export const CROSS_ORIGIN = "https://parity-cross-origin.example";
export const FORM = "application/x-www-form-urlencoded";
/** One byte over 1 MiB: larger than every BODY_LIMIT_BYTES class. */
export const OVERSIZED_BYTES = 1024 * 1024 + 1;
export const EVENT_KEY = "01J00000000000000000000001";
export const MEMBER_ID = "900000000000001398";
export const IDENTITIES = ["member", "moderator", "expired", "forged"];

// Concrete values for every parameter spelling in the inventory and manifest.
const PARAMS = {
  ":key": EVENT_KEY,
  ":file{.+\\.md}": `${EVENT_KEY}.md`,
  ":file{.+\\.ics}": `${EVENT_KEY}.ics`,
  ":id": "1",
  ":user": MEMBER_ID,
  ":signal": "joins",
  ":identity": "qa-member",
};
// Wildcard middleware registrations have no handler of their own; probe each
// with one unregistered child so the guard (or the branded 404) answers.
const WILDCARDS = {
  "/*": "/parity-unregistered",
  "/admin/*": "/admin/parity-unregistered",
  "/admin/queue/*": "/admin/queue/parity-unregistered",
  "/members/*": "/members/parity/unregistered",
};
// `{.+...}` params can span `/`: the multi-segment spelling is its own vector.
const MULTI_SEGMENT = {
  ":file{.+\\.md}": "a/b.md",
  ":file{.+\\.ics}": "a/b.ics",
};

export function concretePath(template) {
  if (WILDCARDS[template]) return WILDCARDS[template];
  return template
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const value = PARAMS[segment];
      if (!value) throw new Error(`No parity value for parameter ${segment} in ${template}`);
      return value;
    })
    .join("/");
}

function replaceParam(template, value) {
  return template
    .split("/")
    .map((segment, index, all) => {
      if (!segment.startsWith(":")) return segment;
      // Only the last parameter varies; earlier ones keep the fixture value.
      const last = all.findLastIndex((s) => s.startsWith(":"));
      return index === last ? value : PARAMS[segment];
    })
    .join("/");
}

/**
 * Stable, collision-checked file stem for a route template or static path.
 * Never starts with a dot: actions/upload-artifact drops hidden files, so a
 * `.well-known/...` golden would silently vanish from the recording artifact.
 */
export function slug(path) {
  if (path === "/") return "root";
  return path
    .slice(1)
    .replace(/\*/g, "ALL")
    .replace(/[{}\\+]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\./, "_");
}

const isBearer = (auth) => auth.endsWith("-bearer");
const isStagingToken = (auth) => auth === "staging-token";

function getFamily(file, path, { identities, conditional }) {
  const vectors = [{ id: "GET accept:html", method: "GET", path, accept: "text/html" }];
  vectors.push({ id: "GET accept:json", method: "GET", path, accept: "application/json" });
  if (identities) {
    for (const identity of IDENTITIES) {
      vectors.push({ id: `GET identity:${identity}`, method: "GET", path, identity });
    }
  }
  if (conditional) {
    vectors.push(
      { id: "GET if-none-match:exact", method: "GET", path, ifNoneMatch: "exact" },
      { id: "GET if-none-match:weak", method: "GET", path, ifNoneMatch: "weak" },
      { id: "GET if-none-match:star", method: "GET", path, ifNoneMatch: "*" },
    );
  }
  return vectors.map((vector) => ({ ...vector, file }));
}

function pathVariants(file, template, path) {
  const variants = [];
  if (!path.endsWith("/")) {
    variants.push({ id: "GET path:trailing-slash", path: `${path}/` });
  }
  variants.push({
    id: "GET path:__data.json",
    path: path === "/" ? "/__data.json" : `${path}/__data.json`,
  });
  const hasParam = template.split("/").some((s) => s.startsWith(":"));
  if (hasParam) {
    variants.push(
      { id: "GET path:encoded-slash", path: replaceParam(template, "a%2Fb") },
      { id: "GET path:encoded-percent", path: replaceParam(template, "a%25b") },
    );
    const last = template.split("/").findLast((s) => s.startsWith(":"));
    if (last && MULTI_SEGMENT[last]) {
      variants.push({
        id: "GET path:multi-segment",
        path: replaceParam(template, MULTI_SEGMENT[last]),
      });
    }
  } else {
    const base = path === "/" ? "" : path;
    variants.push(
      { id: "GET path:encoded-slash", path: `${base}/a%2Fb` },
      { id: "GET path:encoded-percent", path: `${base}%25` },
    );
  }
  return variants.map((variant) => ({ ...variant, method: "GET", file }));
}

function methodFamily(file, path) {
  return METHODS.map((method) => ({
    id: method,
    method,
    path,
    file,
    ...(UNSAFE.has(method) ? { origin: SAME_ORIGIN, contentType: FORM, body: "" } : {}),
  }));
}

function unsafeFamily(file, path, method, auth) {
  const base = { method, path, file, origin: SAME_ORIGIN, contentType: FORM, body: "" };
  const vectors = [
    { id: `${method} origin:cross`, origin: CROSS_ORIGIN },
    { id: `${method} origin:missing`, origin: null },
    { id: `${method} accept:html`, accept: "text/html" },
    { id: `${method} accept:json`, accept: "application/json" },
    { id: `${method} content-type:text`, contentType: "text/plain", body: "parity" },
    { id: `${method} content-type:json`, contentType: "application/json", body: "{}" },
    { id: `${method} body:oversized`, bodyBytes: OVERSIZED_BYTES },
    ...IDENTITIES.map((identity) => ({ id: `${method} identity:${identity}`, identity })),
  ];
  if (isBearer(auth)) {
    vectors.push(
      { id: `${method} bearer:wrong`, authorization: "Bearer parity-wrong-token" },
      { id: `${method} bearer:malformed`, authorization: "Basic cGFyaXR5" },
    );
  }
  if (isStagingToken(auth)) {
    vectors.push(
      { id: `${method} qa-token:wrong`, qaToken: "wrong" },
      { id: `${method} qa-token:valid`, qaToken: "valid" },
    );
  }
  return vectors.map((vector) => ({ ...base, ...vector }));
}

/**
 * The full matrix. inventory: test/fixtures/route-inventory.json entries;
 * publicFiles: `/`-rooted paths under public/; kitPaths: ROUTE_MANIFEST GET
 * paths; throttles: { path, method, limit } bursts recorded at limit + 1.
 */
export function buildVectors({ inventory, publicFiles, kitPaths, throttles }) {
  const templates = new Map();
  for (const entry of inventory) {
    const row = templates.get(entry.path) ?? { methods: new Set(), auth: new Map() };
    row.methods.add(entry.method);
    row.auth.set(entry.method, entry.auth);
    templates.set(entry.path, row);
  }
  const vectors = [];
  const coverage = [];
  const files = new Map();
  const claim = (file, source) => {
    const prior = files.get(file);
    if (prior && prior !== source)
      throw new Error(`Parity file collision: ${file} (${prior}, ${source})`);
    files.set(file, source);
  };
  const concreteFiles = new Map();

  for (const [template, row] of [...templates].sort(([a], [b]) => a.localeCompare(b))) {
    const file = `routes/${slug(template)}`;
    claim(file, template);
    const path = concretePath(template);
    concreteFiles.set(path, file);
    vectors.push(...methodFamily(file, path));
    const gettable = row.methods.has("GET") || row.methods.has("ALL");
    if (gettable) {
      vectors.push(...getFamily(file, path, { identities: true, conditional: true }));
      vectors.push(...pathVariants(file, template, path));
    }
    for (const method of [...row.methods].sort()) {
      if (UNSAFE.has(method))
        vectors.push(...unsafeFamily(file, path, method, row.auth.get(method)));
      coverage.push({
        entry: `${method} ${template}`,
        file,
        vector: method === "ALL" ? "GET" : method,
      });
    }
  }

  for (const kitPath of [...new Set(kitPaths)].sort()) {
    const path = concretePath(kitPath);
    const existing = concreteFiles.get(path);
    if (existing) {
      coverage.push({ entry: `KIT GET ${kitPath}`, file: existing, vector: "GET" });
      continue;
    }
    const file = `kit/${slug(path)}`;
    claim(file, kitPath);
    concreteFiles.set(path, file);
    vectors.push(...methodFamily(file, path));
    vectors.push(...getFamily(file, path, { identities: true, conditional: true }));
    vectors.push(...pathVariants(file, kitPath, path));
    coverage.push({ entry: `KIT GET ${kitPath}`, file, vector: "GET" });
  }

  for (const publicPath of [...publicFiles].sort()) {
    const file = `static/${slug(publicPath)}`;
    claim(file, publicPath);
    vectors.push(...methodFamily(file, publicPath));
    vectors.push(...getFamily(file, publicPath, { identities: false, conditional: true }));
    vectors.push({ id: "GET path:trailing-slash", method: "GET", path: `${publicPath}/`, file });
    coverage.push({ entry: `STATIC GET ${publicPath}`, file, vector: "GET" });
  }

  for (const throttle of throttles) {
    const file = concreteFiles.get(throttle.path);
    if (!file) throw new Error(`Throttle vector ${throttle.path} has no route file`);
    vectors.push({
      id: `${throttle.method} throttle:exhausted`,
      method: throttle.method,
      path: throttle.path,
      file,
      repeat: throttle.limit + 1,
      ...(UNSAFE.has(throttle.method) ? { origin: SAME_ORIGIN, contentType: FORM, body: "" } : {}),
    });
  }

  const seen = new Set();
  for (const vector of vectors) {
    const key = `${vector.file}#${vector.id}`;
    if (seen.has(key)) throw new Error(`Duplicate parity vector ${key}`);
    seen.add(key);
  }
  return { vectors, coverage };
}

export function listPublicFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`/${relative(root, full).split(sep).join("/")}`);
    }
  };
  walk(root);
  return out.sort();
}

/** Reads the route sources. Needs `node --import tsx` for the TS manifest. */
export async function loadVectorInputs(repo) {
  const inventory = JSON.parse(
    readFileSync(join(repo, "test/fixtures/route-inventory.json"), "utf8"),
  );
  const publicFiles = listPublicFiles(join(repo, "public"));
  const { ROUTE_MANIFEST } = await import(join(repo, "src/route-ownership.ts"));
  const kitPaths = ROUTE_MANIFEST.filter((route) => route.method === "GET").map(
    (route) => route.path,
  );
  const { AUTH_THROTTLE_PER_MINUTE, WRITE_THROTTLE_PER_MINUTE } = await import(
    join(repo, "src/throttle.ts")
  );
  const throttles = [
    { method: "GET", path: "/join/discord", limit: AUTH_THROTTLE_PER_MINUTE },
    { method: "GET", path: "/auth/discord", limit: AUTH_THROTTLE_PER_MINUTE },
    { method: "POST", path: "/logout", limit: WRITE_THROTTLE_PER_MINUTE },
    // Anonymous public-read budget: production keeps 60 per minute per client.
    { method: "GET", path: "/events", limit: 60 },
  ];
  return { inventory, publicFiles, kitPaths, throttles };
}
