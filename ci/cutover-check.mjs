// Manual W16 gate. CI runs only cutover-check-selftest.mjs, never these live probes.
import { execFile } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { headerIndexingRules } from "./robots-directives.mjs";

const exec = promisify(execFile);
export const ORIGIN_HEADER = "x-two-origin";
export const NEXT_IDENTITY = "two-web-next";
const freezeFile = new URL("../docs/url-freeze.md", import.meta.url);

// Patterns have representative GETs, not an assertion about every possible key.
// No cookies, OAuth codes, POSTs or redirect-following: these are guest probes.
export const URL_CASES = [
  { frozen: "/", path: "/", status: 200, html: true, indexable: true },
  { frozen: "/discord", path: "/discord", status: 302, redirect: "invite" },
  ...["/about", "/faq", "/rules", "/privacy", "/join", "/events"].map((path) => ({
    frozen: path,
    path,
    status: 200,
    html: true,
    indexable: true,
  })),
  { frozen: "/sitemap_index.xml", path: "/sitemap_index.xml", status: 200 },
  { frozen: "/robots.txt", path: "/robots.txt", status: 200 },
  { frozen: "/join/discord", path: "/join/discord", status: 302, redirect: "oauth" },
  { frozen: "/join/callback", path: "/join/callback", status: 200 },
  { frozen: "/auth/discord", path: "/auth/discord", status: 302, redirect: "oauth" },
  {
    frozen: "/auth/discord/redirect",
    path: "/auth/discord/redirect",
    status: 302,
    redirect: "/auth/discord",
    noStore: true,
  },
  {
    frozen: "/auth/discord/callback",
    path: "/auth/discord/callback",
    status: 302,
    redirect: "/?n=signin_failed",
  },
  { frozen: "/events/past", path: "/events/past", status: 200, html: true, indexable: false },
  { frozen: "/e/{key}", path: "/e/{key}", status: 200, html: true, indexable: true },
  { frozen: "/events.json", path: "/events.json", status: 401 },
  { frozen: "/events/{key}", path: "/events/{key}", status: 401 },
  { frozen: ".ics", path: "/events.ics", status: 200 },
  { frozen: ".ics", path: "/events/{key}.ics", status: 200 },
  { frozen: ".rss", path: "/events.rss", status: 200 },
  { frozen: "/profile", path: "/profile", status: 302, redirect: "/auth/discord" },
  { frozen: "/members/{user}", path: "/members/{user}", status: 302, redirect: "/auth/discord" },
  { frozen: "/admin/*", path: "/admin", status: 302, redirect: "/auth/discord" },
  { frozen: "/admin/*", path: "/admin/events", status: 302, redirect: "/auth/discord" },
  // Legacy Filament bookmarks run behind the moderator guard: guests 302 to
  // OAuth (moderators 301 to the canonical target after the guard). The JSON
  // show 401 above (TOG-11155) pins the session-gated contract.
  { frozen: "/admin/*", path: "/admin/events/{key}/edit", status: 302, redirect: "/auth/discord" },
  { frozen: "/admin/*", path: "/admin/featured-contents", status: 302, redirect: "/auth/discord" },
  ...["/health", "/healthz", "/db-ping"].map((path) => ({ frozen: path, path, status: 404 })),
  { frozen: "/up", path: "/up", status: 200 },
  // Retired URLs from legacy ci/live-seo-probe.mjs plus PHP/Livewire endpoints.
  ...[
    "/about-us/",
    "/news/",
    "/members",
    "/gamipress/points/",
    "/events/month/2024-01/",
    "/this-url-never-existed-abc123xyz/",
    "/wp-json/",
    "/wp-login.php",
    "/livewire/livewire.js",
    "/livewire/update",
  ].map((path) => ({ frozen: path, path, status: 404 })),
];

export function uncoveredFrozenPaths(markdown) {
  const paths = [...markdown.matchAll(/^\|\s*([^|]+)\|/gm)]
    .flatMap((match) => [...match[1].matchAll(/`([^`]+)`/g)].map((token) => token[1]))
    // Mounted method/middleware inventory is checked by route-inventory.test.ts,
    // not a frozen guest-GET contract (and must never trigger write probes).
    .filter((path) => !/^(?:ALL|GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\s+\//.test(path));
  return [...new Set(paths)].filter((path) => !URL_CASES.some((row) => row.frozen === path));
}

function host(value) {
  if (!value || !/^[a-z0-9.-]+$/i.test(value) || !value.includes(".") || value.startsWith("-")) {
    throw new Error("hosts must be DNS names, without a scheme, port or path");
  }
  return value.toLowerCase();
}

export function parseArgs(argv) {
  const options = {
    apex: "togetherweown.com",
    memberId: "0",
    legacyIdentity: "two-web",
    expectedIps: [],
  };
  const names = {
    "--phase": "phase",
    "--target": "target",
    "--apex": "apex",
    "--event-key": "eventKey",
    "--member-id": "memberId",
    "--legacy-identity": "legacyIdentity",
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if ((!names[flag] && flag !== "--expect-ip") || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(`unknown option or missing value: ${flag}`);
    }
    const value = argv[++i];
    if (flag === "--expect-ip") {
      if (!isIP(value)) throw new Error("--expect-ip requires an IP address");
      options.expectedIps.push(value);
    } else {
      if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
      seen.add(flag);
      options[names[flag]] = value;
    }
  }
  if (!["before", "after"].includes(options.phase))
    throw new Error("--phase before|after is required");
  options.target = host(options.target);
  options.apex = host(options.apex);
  if ((options.phase === "after") !== (options.target === options.apex)) {
    throw new Error("before: target the separate Next candidate; after: target the apex");
  }
  if (options.eventKey && !/^[a-zA-Z0-9_-]+$/.test(options.eventKey))
    throw new Error("invalid event key");
  if (!/^\d+$/.test(options.memberId)) throw new Error("invalid member id");
  if (
    !/^[a-zA-Z0-9_-]+$/.test(options.legacyIdentity) ||
    options.legacyIdentity === NEXT_IDENTITY
  ) {
    throw new Error("legacy identity must be a distinct fixed marker");
  }
  return options;
}

// curl keeps the legacy probe's browser-compatible TLS handshake. No curlrc,
// proxy, cookie jar, retries, -k or -L; HTTP failures are measured, not swallowed.
// --resolve pins the measured DNS answers without changing TLS SNI/verification.
// Sources: https://curl.se/docs/manpage.html#--resolve and #--disable
export async function curlRequest(url, addresses, { connectTo, caFile, timeout = 15 } = {}) {
  if (addresses.length !== 1 || !isIP(addresses[0]))
    throw new Error("probe exactly one DNS address per transfer");
  const parsed = new URL(url);
  const dir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "cutover-"));
  try {
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const args = [
      "-q",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--proto",
      "=http,https",
      "--connect-timeout",
      String(timeout),
      "--max-time",
      String(timeout),
      "--max-filesize",
      "2097152",
      "--user-agent",
      "Mozilla/5.0 TWO-cutover-check",
      "--dump-header",
      join(dir, "headers"),
      "--output",
      join(dir, "body"),
      "--write-out",
      "%{json}",
    ];
    if (connectTo) args.push("--connect-to", `${parsed.hostname}:${port}:127.0.0.1:${connectTo}`);
    else
      args.push(
        "--resolve",
        `${parsed.hostname}:${port}:${addresses.map((ip) => (isIP(ip) === 6 ? `[${ip}]` : ip)).join(",")}`,
      );
    if (caFile) args.push("--cacert", caFile); // local TLS fixture seam, not a CLI flag
    args.push("--url", url);
    const { stdout } = await exec("curl", args, {
      timeout: (timeout + 2) * 1000,
      maxBuffer: 65536,
    });
    const meta = JSON.parse(stdout);
    const blocks = (await readFile(join(dir, "headers"), "utf8")).trim().split(/\r?\n\r?\n/);
    const headers = {};
    for (const line of blocks.at(-1).split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      // Preserve header boundaries: a crawler scope lasts only within that field.
      if (key === "x-robots-tag") (headers[key] ??= []).push(value);
      else headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    return {
      status: meta.http_code,
      headers,
      body: await readFile(join(dir, "body"), "utf8"),
      tlsVerified: parsed.protocol === "https:" && meta.ssl_verify_result === 0,
      remoteIp: meta.remote_ip,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Independent resolver, bounded and injectable; ENODATA is an absent family,
// not an outage. SERVFAIL/timeouts/REFUSED are fatal even if the other family works.
// Source: https://nodejs.org/docs/latest-v24.x/api/dns.html#class-dnspromisesresolver
export async function dnsAnswers(name, resolver) {
  const answers = await Promise.all(
    ["resolve4", "resolve6"].map(async (method) => {
      try {
        return await resolver[method](name);
      } catch (err) {
        if (err.code === "ENODATA") return [];
        throw err;
      }
    }),
  );
  return [...new Set(answers.flat())];
}

// RFC 9111/9110: commas separate directives only outside quoted strings.
// no-store takes no argument; malformed fields fail closed, even after a match.
function hasNoStore(header = "") {
  if (/[\r\n]/.test(header)) return false;
  const fields = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") {
      fields.push(header.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted || escaped) return false;
  fields.push(header.slice(start));
  let found = false;
  for (const field of fields) {
    if (/^[ \t]*$/.test(field)) continue;
    const directive = field.match(
      /^[ \t]*([!#$%&'*+.^_`|~\da-z-]+)(?:[ \t]*=[ \t]*([!#$%&'*+.^_`|~\da-z-]+|"(?:[\t\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"))?[ \t]*$/i,
    );
    if (!directive) return false;
    if (directive[1].toLowerCase() === "no-store" && directive[2] === undefined) found = true;
  }
  return found;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => {
    const attrs = {};
    for (const attr of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    }
    return attrs;
  });
}
// One pass only: &amp;quot; is the literal &quot;, not a quote.
export const xmlText = (value) =>
  value.replace(
    /&(amp|quot|apos|lt|gt);/g,
    (_, entity) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity],
  );
function absoluteOn(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
function indexingRules(header, html) {
  const rules = headerIndexingRules(header);
  for (const tag of tags(html, "meta")) {
    const name = tag.name?.toLowerCase();
    if (!["robots", "googlebot", "googlebot-news", "bingbot"].includes(name)) continue;
    if (
      (tag.content ?? "")
        .toLowerCase()
        .split(",")
        .some((token) => ["noindex", "none"].includes(token.trim()))
    ) {
      rules.push({ crawler: name === "robots" ? "*" : name, source: "meta" });
    }
  }
  return rules;
}

// RFC 9309: strip comments, combine matching groups, fall back to *, and
// prefer the longest matching path (Allow wins a tie). No regex backtracking.
// Source: https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2
function robotsGroups(body) {
  const groups = [];
  let group;
  for (const line of body.split(/\r?\n/)) {
    const field = line
      .split("#", 1)[0]
      .trim()
      .match(/^([\w-]+):\s*(.*)$/);
    if (!field) continue;
    const name = field[1].toLowerCase();
    const value = field[2].trim();
    if (name === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow"].includes(name)) {
      group.rules.push({ allow: name === "allow", pattern: value });
    }
  }
  return groups;
}
function normalizeRobotsPath(value) {
  return value
    .replace(/[^\x00-\x7f]/gu, (char) => encodeURIComponent(char))
    .replace(/%[\da-f]{2}/gi, (encoded) => {
      const char = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
      return /^[\w.~-]$/.test(char) ? char : encoded.toUpperCase();
    });
}
function matchesRobotsPath(pattern, path) {
  pattern = normalizeRobotsPath(pattern);
  path = normalizeRobotsPath(path);
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!path.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const at =
      anchored && i === parts.length - 1 ? path.length - part.length : path.indexOf(part, offset);
    if (at < offset || !path.startsWith(part, at)) return false;
    offset = at + part.length;
  }
  return !anchored || offset === path.length;
}
function robotsAllows(groups, crawler, path) {
  const matching = groups.filter((group) => group.agents.includes(crawler));
  const applicable = matching.length
    ? matching
    : groups.filter((group) => group.agents.includes("*"));
  const rules = applicable
    .flatMap((group) => group.rules)
    .filter((rule) => rule.pattern && matchesRobotsPath(rule.pattern, path));
  const length = (rule) => Buffer.byteLength(normalizeRobotsPath(rule.pattern));
  const longest = rules.reduce((max, rule) => Math.max(max, length(rule)), 0);
  const best = rules.filter((rule) => length(rule) === longest);
  return !best.length || best.some((rule) => rule.allow);
}

export async function runChecks(
  options,
  {
    resolver = new Resolver({ timeout: 3000, tries: 1 }),
    request = curlRequest,
    freeze = null,
  } = {},
) {
  const checks = [];
  const record = (id, ok, detail, address) =>
    checks.push({ id, ok: Boolean(ok), detail, ...(address !== undefined ? { address } : {}) });
  const markdown = freeze ?? (await readFile(freezeFile, "utf8"));
  const uncovered = uncoveredFrozenPaths(markdown);
  record(
    "url-freeze-coverage",
    uncovered.length === 0,
    uncovered.length ? `unmapped: ${uncovered.join(", ")}` : "all frozen patterns mapped",
  );
  const addresses = new Map();
  for (const name of new Set([options.target, options.apex, `www.${options.apex}`])) {
    try {
      const ips = await dnsAnswers(name, resolver);
      addresses.set(name, ips);
      record(`dns:${name}`, ips.length > 0, ips.join(", ") || "no A/AAAA answers");
      if (name === options.target && options.expectedIps.length) {
        record(
          `dns-expected:${name}`,
          ips.length > 0 && ips.every((ip) => options.expectedIps.includes(ip)),
          "every returned target address must belong to --expect-ip allowlist",
        );
      }
    } catch (err) {
      record(`dns:${name}`, false, err.code ?? err.message);
    }
  }
  const cache = new Map();
  const probe = async (url) => {
    const ips = addresses.get(new URL(url).hostname);
    const results = [];
    // Include a failed measurement when DNS is absent; never silently skip it.
    for (const ip of ips?.length ? ips : [null]) {
      const key = `${url}\0${ip}`;
      if (!cache.has(key)) {
        let response = null;
        try {
          if (!ip) throw new Error("no verified DNS answers");
          response = await request(url, [ip]);
          if (new URL(url).protocol === "https:")
            record(
              `tls:${url}`,
              response.tlsVerified,
              "certificate chain and hostname verification",
              ip,
            );
        } catch (err) {
          record(`transport:${url}`, false, `probe failed (${err.code ?? err.name})`, ip);
        }
        cache.set(key, response);
      }
      results.push({ ip, response: cache.get(key) });
    }
    return results;
  };
  const measure = async (url, evaluate) => {
    for (const { ip, response } of await probe(url)) {
      evaluate(response, (id, ok, detail) => record(id, ok, detail, ip));
    }
  };
  const origin = `https://${options.target}`;
  const apex = `https://${options.apex}`;
  await measure(`${origin}/up`, (up, record) => {
    record(
      "target-origin",
      up?.status === 200 && up.headers[ORIGIN_HEADER] === NEXT_IDENTITY,
      `expected 200 + ${ORIGIN_HEADER}: ${NEXT_IDENTITY}`,
    );
    record(
      "target-up-no-store",
      hasNoStore(up?.headers["cache-control"]),
      "identity response must not be cached",
    );
  });
  const expectedIdentity = options.phase === "before" ? options.legacyIdentity : NEXT_IDENTITY;
  await measure(`${apex}/up`, (up, record) => {
    record(
      "apex-origin",
      up?.status === 200 && up.headers[ORIGIN_HEADER] === expectedIdentity,
      `expected 200 + ${ORIGIN_HEADER}: ${expectedIdentity}; missing is not proof of legacy`,
    );
  });
  await measure(`${apex}/`, (home, record) => {
    record("apex-home", home?.status === 200, "apex HTTPS must serve directly, not loop/redirect");
  });
  const redirectPath = "/about?cutover=1";
  for (const base of [
    `http://${options.apex}`,
    `http://www.${options.apex}`,
    `https://www.${options.apex}`,
  ]) {
    await measure(`${base}${redirectPath}`, (response, record) => {
      record(
        `edge-redirect:${base}`,
        [301, 308].includes(response?.status) &&
          response.headers.location === `${apex}${redirectPath}`,
        "single permanent hop to HTTPS apex, preserving path/query",
      );
    });
  }
  let eventKey = options.eventKey;
  await measure(`${origin}/sitemap_index.xml`, (sitemap, record) => {
    const locs = [...(sitemap?.body ?? "").matchAll(/<loc\b[^>]*>([^<]+)<\/loc>/gi)].map((match) =>
      xmlText(match[1].trim()),
    );
    record(
      "sitemap",
      sitemap?.status === 200 &&
        /<urlset\b/i.test(sitemap.body) &&
        locs.length > 0 &&
        locs.every((url) => absoluteOn(url, origin)),
      "nonempty urlset, every loc absolute HTTPS on target host",
    );
    if (!eventKey) {
      const event = locs.find(
        (url) => absoluteOn(url, origin) && /^\/e\/[\w-]+$/.test(new URL(url).pathname),
      );
      if (event) eventKey = new URL(event).pathname.slice(3);
    }
  });
  record(
    "published-event-fixture",
    Boolean(eventKey),
    "use a published sitemap event or --event-key; never skip a frozen pattern",
  );
  await measure(`${origin}/robots.txt`, (robots, record) => {
    const body = (robots?.body ?? "")
      .split(/\r?\n/)
      .map((line) => line.split("#", 1)[0])
      .join("\n");
    const robotsSitemaps = [...body.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map(
      (match) => match[1],
    );
    record(
      "robots-sitemap",
      robots?.status === 200 &&
        robotsSitemaps.length > 0 &&
        robotsSitemaps.every((url) => url === `${origin}/sitemap_index.xml`),
      "robots sitemap advertises the target origin",
    );
    const groups = robotsGroups(body);
    const paths = URL_CASES.filter((row) => row.indexable).map((row) =>
      row.path.replace("{key}", eventKey),
    );
    const blocked = ["*", "googlebot", "googlebot-news", "bingbot"].flatMap((crawler) =>
      paths
        .filter((path) => !robotsAllows(groups, crawler, path))
        .map((path) => `${crawler}:${path}`),
    );
    // Preview headers need to be crawlable to be seen; after, public pages must
    // be crawlable by generic and supported search crawlers, not unrelated bots.
    record(
      "robots-after-crawlable",
      options.phase === "before" || blocked.length === 0,
      blocked.length ? `blocked public paths: ${blocked.join(", ")}` : "public paths crawlable",
    );
  });
  for (const row of URL_CASES) {
    if (row.path.includes("{key}") && !eventKey) {
      record(`url:${row.path}`, false, "published event key missing");
      continue;
    }
    const path = row.path.replace("{key}", eventKey).replace("{user}", options.memberId);
    const url = `${origin}${path}`;
    await measure(url, (response, record) => {
      record(
        `url:${path}`,
        response?.status === row.status,
        `expected ${row.status}, received ${response?.status ?? "no response"}`,
      );
      if (!response) return;
      if (row.noStore)
        record(
          `no-store:${path}`,
          hasNoStore(response.headers["cache-control"]),
          "redirect must not be cached",
        );
      if (row.redirect) {
        let location;
        try {
          location = new URL(response.headers.location, url);
        } catch {
          /* fails below */
        }
        let ok = false;
        if (row.redirect === "invite") {
          ok =
            location?.protocol === "https:" &&
            !location.username &&
            !location.password &&
            ((location.hostname === "discord.gg" && /^\/[\w-]+$/.test(location.pathname)) ||
              (location.hostname === "discord.com" &&
                /^\/invite\/[\w-]+$/.test(location.pathname)));
          record(
            "discord-no-store",
            hasNoStore(response.headers["cache-control"]),
            "invite must not be cached",
          );
        } else if (row.redirect === "oauth") {
          const callback = path.startsWith("/join") ? "/join/callback" : "/auth/discord/callback";
          ok =
            location?.origin === "https://discord.com" &&
            location.pathname === "/oauth2/authorize" &&
            location.searchParams.get("redirect_uri") === `${origin}${callback}`;
        } else ok = location?.href === `${origin}${row.redirect}`;
        record(`location:${path}`, ok, `expected ${row.redirect} redirect (not followed)`);
      }
      if (row.html) {
        record(
          `html:${path}`,
          /\btext\/html\b/i.test(response.headers["content-type"] ?? ""),
          "HTML, not a JSON/challenge status substitute",
        );
        const canonicals = tags(response.body, "link").filter(
          (tag) => tag.rel?.toLowerCase() === "canonical",
        );
        record(
          `canonical:${path}`,
          canonicals.length === 1 && canonicals[0].href === url,
          "one absolute self-canonical on target host",
        );
        const rules = indexingRules(response.headers["x-robots-tag"], response.body);
        const shouldIndex = options.phase === "after" && row.indexable;
        record(
          `indexing:${path}`,
          shouldIndex ? rules.length === 0 : rules.some((rule) => rule.crawler === "*"),
          shouldIndex
            ? "indexable after flip, including crawler-scoped rules"
            : "must be universally noindex",
        );
        if (options.phase === "before")
          record(
            `preview-header:${path}`,
            rules.some((rule) => rule.source === "header" && rule.crawler === "*"),
            "preview HTML needs unscoped X-Robots-Tag noindex/none",
          );
      }
    });
  }
  return {
    phase: options.phase,
    target: options.target,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runChecks(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`cutover-check: ${result.phase} ${result.target}`);
      for (const check of result.checks)
        console.log(
          `${check.ok ? "PASS" : "FAIL"} ${check.id}${check.address ? ` [${check.address}]` : ""}: ${check.detail}`,
        );
      console.log(
        `${result.checks.filter((check) => !check.ok).length} failure(s); no DNS/configuration changes executed`,
      );
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(
      `cutover-check: ${err.message}\nUsage: node ci/cutover-check.mjs --phase before|after --target <host> [--event-key <published-key>] [--expect-ip <ip>] [--json]`,
    );
    process.exitCode = 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
