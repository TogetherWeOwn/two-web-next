#!/usr/bin/env node
// W16 shadow run (TOG-9698): read-only guest GETs against the legacy VPS
// canonical and the Next candidate, one record per path per cycle.
// Never authenticates, never follows redirects, never sends a body.
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_PATHS = [
  "/",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
  "/join",
  "/events",
  "/events/past",
  "/events.json",
  "/events.rss",
  "/events.ics",
  "/sitemap_index.xml",
  "/robots.txt",
  "/discord",
  "/up",
  "/__shadow_unknown_route__",
];
const HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const UA = "two-shadow-compare/1 (+TOG-9698; read-only)";

export function parseArgs(argv) {
  const o = {
    legacy: "https://togetherweown.com",
    next: "https://next.togetherweown.com",
    paths: DEFAULT_PATHS,
    intervalS: 300,
    durationH: 0,
    out: null,
    summarize: null,
    timeoutMs: 10_000,
  };
  const take = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--legacy") o.legacy = take(i++, a);
    else if (a === "--next") o.next = take(i++, a);
    else if (a === "--paths") o.paths = take(i++, a).split(",").filter(Boolean);
    else if (a === "--interval-s") o.intervalS = Number(take(i++, a));
    else if (a === "--duration-h") o.durationH = Number(take(i++, a));
    else if (a === "--timeout-ms") o.timeoutMs = Number(take(i++, a));
    else if (a === "--out") o.out = take(i++, a);
    else if (a === "--summarize") o.summarize = take(i++, a);
    else throw new Error(`unknown argument ${a}`);
  }
  for (const key of ["legacy", "next"]) {
    const u = new URL(o[key]);
    if (u.protocol !== "https:" && !isLoopback(u.hostname))
      throw new Error(`--${key} must be https`);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
      throw new Error(`--${key} must be a bare origin`);
    }
    if (!HOSTNAME.test(u.hostname) && !isLoopback(u.hostname))
      throw new Error(`--${key} must be a DNS host`);
    o[key] = u.origin;
  }
  if (o.legacy === o.next) throw new Error("--legacy and --next must differ");
  for (const p of o.paths)
    if (!p.startsWith("/") || p.startsWith("//")) throw new Error(`bad path ${p}`);
  if (!(o.intervalS >= 30) || !(o.durationH >= 0) || !(o.timeoutMs > 0))
    throw new Error("bad interval/duration/timeout");
  return o;
}

const isLoopback = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";

// Replace the origin so that the only expected difference (host) cancels out.
const normalize = (value, origin) => (value ?? "").split(origin).join("«origin»");
const first = (html, re) => re.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? null;

export function describe(response, body, origin) {
  const h = response.headers;
  const html = (h.get("content-type") ?? "").startsWith("text/html");
  return {
    status: response.status,
    contentType: h.get("content-type")?.split(";")[0].trim().toLowerCase() ?? null,
    location: h.get("location") ? normalize(h.get("location"), origin) : null,
    cacheControl: h.get("cache-control"),
    title: html ? first(body, /<title[^>]*>([\s\S]*?)<\/title>/i) : null,
    h1: html ? first(body, /<h1[^>]*>([\s\S]*?)<\/h1>/i) : null,
    canonical: html
      ? normalize(first(body, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i), origin)
      : null,
    bodyBytes: Buffer.byteLength(body),
  };
}

// Fields compared exactly; bodyBytes only past a 25% spread. Cache-Control is
// informational because edge layers rewrite it differently.
const STRICT = ["status", "contentType", "location", "title", "h1", "canonical"];

export function diff(a, b) {
  const out = STRICT.filter((k) => a[k] !== b[k]).map((k) => ({
    field: k,
    legacy: a[k],
    next: b[k],
  }));
  const big = Math.max(a.bodyBytes, b.bodyBytes);
  if (big > 0 && Math.abs(a.bodyBytes - b.bodyBytes) / big > 0.25) {
    out.push({ field: "bodyBytes", legacy: a.bodyBytes, next: b.bodyBytes });
  }
  if (a.cacheControl !== b.cacheControl) {
    out.push({
      field: "cacheControl",
      legacy: a.cacheControl,
      next: b.cacheControl,
      informational: true,
    });
  }
  return out;
}

async function probe(origin, path, timeoutMs, fetchImpl) {
  const t0 = performance.now();
  try {
    const r = await fetchImpl(new URL(path, origin), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" },
    });
    const body = await r.text();
    return { ms: Math.round(performance.now() - t0), page: describe(r, body, origin) };
  } catch (error) {
    return {
      ms: Math.round(performance.now() - t0),
      error: `${error?.name ?? "Error"}: ${error?.message ?? error}`,
    };
  }
}

export async function cycle(options, fetchImpl = fetch, now = () => new Date()) {
  const results = [];
  for (const path of options.paths) {
    const [l, n] = await Promise.all([
      probe(options.legacy, path, options.timeoutMs, fetchImpl),
      probe(options.next, path, options.timeoutMs, fetchImpl),
    ]);
    const diffs =
      l.error || n.error
        ? [{ field: "transport", legacy: l.error ?? "ok", next: n.error ?? "ok" }]
        : diff(l.page, n.page);
    results.push({
      path,
      legacyMs: l.ms,
      nextMs: n.ms,
      diffs,
      ok: diffs.every((d) => d.informational),
    });
  }
  return { ts: now().toISOString(), results };
}

const pct = (xs, p) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]
    : null;

export function summarize(records) {
  const byPath = new Map();
  for (const rec of records)
    for (const r of rec.results) {
      const s = byPath.get(r.path) ?? {
        path: r.path,
        samples: 0,
        mismatches: 0,
        fields: {},
        legacyMs: [],
        nextMs: [],
      };
      s.samples++;
      s.legacyMs.push(r.legacyMs);
      s.nextMs.push(r.nextMs);
      if (!r.ok) s.mismatches++;
      for (const d of r.diffs.filter((d) => !d.informational))
        s.fields[d.field] = (s.fields[d.field] ?? 0) + 1;
      byPath.set(r.path, s);
    }
  const paths = [...byPath.values()].map(({ legacyMs, nextMs, ...s }) => ({
    ...s,
    legacyP50: pct(legacyMs, 0.5),
    legacyP95: pct(legacyMs, 0.95),
    nextP50: pct(nextMs, 0.5),
    nextP95: pct(nextMs, 0.95),
  }));
  return {
    cycles: records.length,
    firstTs: records[0]?.ts ?? null,
    lastTs: records.at(-1)?.ts ?? null,
    hours:
      records.length > 1
        ? +((Date.parse(records.at(-1).ts) - Date.parse(records[0].ts)) / 3.6e6).toFixed(2)
        : 0,
    clean: paths.every((p) => p.mismatches === 0),
    paths,
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.summarize) {
    const lines = (await readFile(o.summarize, "utf8")).split("\n").filter(Boolean);
    console.log(JSON.stringify(summarize(lines.map((l) => JSON.parse(l))), null, 2));
    return;
  }
  const deadline = o.durationH ? Date.now() + o.durationH * 3.6e6 : 0;
  for (;;) {
    const rec = await cycle(o);
    const line = JSON.stringify(rec);
    if (o.out) await appendFile(o.out, `${line}\n`);
    else console.log(line);
    const bad = rec.results.filter((r) => !r.ok);
    console.error(
      `${rec.ts} ${bad.length ? `${bad.length} mismatch: ${bad.map((r) => r.path).join(" ")}` : "ok"}`,
    );
    if (!deadline || Date.now() + o.intervalS * 1000 > deadline) break;
    await new Promise((r) => setTimeout(r, o.intervalS * 1000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(2);
  });
}
