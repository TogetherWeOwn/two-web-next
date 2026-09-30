// Manual W16 gate. CI runs only cutover-check-selftest.mjs, never these live probes.
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const ORIGIN_HEADER = 'x-two-origin';
export const NEXT_IDENTITY = 'two-web-next';
const freezeFile = new URL('../docs/url-freeze.md', import.meta.url);

// Patterns have representative GETs, not an assertion about every possible key.
// No cookies, OAuth codes, POSTs or redirect-following: these are guest probes.
export const URL_CASES = [
  { frozen: '/', path: '/', status: 200, html: true, indexable: true },
  { frozen: '/discord', path: '/discord', status: 302, redirect: 'invite' },
  ...['/about', '/faq', '/rules', '/privacy', '/join', '/events'].map(path =>
    ({ frozen: path, path, status: 200, html: true, indexable: true })),
  { frozen: '/sitemap_index.xml', path: '/sitemap_index.xml', status: 200 },
  { frozen: '/robots.txt', path: '/robots.txt', status: 200 },
  { frozen: '/join/discord', path: '/join/discord', status: 302, redirect: 'oauth' },
  { frozen: '/join/callback', path: '/join/callback', status: 200 },
  { frozen: '/auth/discord', path: '/auth/discord', status: 302, redirect: 'oauth' },
  { frozen: '/auth/discord/callback', path: '/auth/discord/callback', status: 302, redirect: '/?n=signin_failed' },
  { frozen: '/events/past', path: '/events/past', status: 200, html: true, indexable: false },
  { frozen: '/e/{key}', path: '/e/{key}', status: 200, html: true, indexable: true },
  { frozen: '/events.json', path: '/events.json', status: 401 },
  { frozen: '.ics', path: '/events.ics', status: 200 },
  { frozen: '.ics', path: '/events/{key}.ics', status: 200 },
  { frozen: '.rss', path: '/events.rss', status: 200 },
  { frozen: '/profile', path: '/profile', status: 302, redirect: '/auth/discord' },
  { frozen: '/members/{user}', path: '/members/{user}', status: 302, redirect: '/auth/discord' },
  { frozen: '/admin/*', path: '/admin', status: 302, redirect: '/auth/discord' },
  { frozen: '/admin/*', path: '/admin/events', status: 302, redirect: '/auth/discord' },
  { frozen: '/healthz', path: '/healthz', status: 200 },
  { frozen: '/up', path: '/up', status: 200 },
  // Retired URLs from legacy ci/live-seo-probe.mjs plus PHP/Livewire endpoints.
  ...['/about-us/', '/news/', '/members', '/gamipress/points/', '/events/month/2024-01/',
    '/this-url-never-existed-abc123xyz/', '/wp-json/', '/wp-login.php',
    '/livewire/livewire.js', '/livewire/update', '/auth/discord/redirect'].map(path =>
    ({ frozen: path, path, status: 404 })),
];

export function uncoveredFrozenPaths(markdown) {
  const paths = [...markdown.matchAll(/^\|\s*([^|]+)\|/gm)]
    .flatMap(match => [...match[1].matchAll(/`([^`]+)`/g)].map(token => token[1]));
  return [...new Set(paths)].filter(path => !URL_CASES.some(row => row.frozen === path));
}

function host(value) {
  if (!value || !/^[a-z0-9.-]+$/i.test(value) || !value.includes('.') || value.startsWith('-')) {
    throw new Error('hosts must be DNS names, without a scheme, port or path');
  }
  return value.toLowerCase();
}

export function parseArgs(argv) {
  const options = { apex: 'togetherweown.com', memberId: '0', legacyIdentity: 'two-web', expectedIps: [] };
  const names = { '--phase': 'phase', '--target': 'target', '--apex': 'apex',
    '--event-key': 'eventKey', '--member-id': 'memberId', '--legacy-identity': 'legacyIdentity' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') { options.json = true; continue; }
    if ((!names[flag] && flag !== '--expect-ip') || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`unknown option or missing value: ${flag}`);
    }
    const value = argv[++i];
    if (flag === '--expect-ip') {
      if (!isIP(value)) throw new Error('--expect-ip requires an IP address');
      options.expectedIps.push(value);
    } else {
      if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
      seen.add(flag);
      options[names[flag]] = value;
    }
  }
  if (!['before', 'after'].includes(options.phase)) throw new Error('--phase before|after is required');
  options.target = host(options.target);
  options.apex = host(options.apex);
  if ((options.phase === 'after') !== (options.target === options.apex)) {
    throw new Error('before: target the separate Next candidate; after: target the apex');
  }
  if (options.eventKey && !/^[a-zA-Z0-9_-]+$/.test(options.eventKey)) throw new Error('invalid event key');
  if (!/^\d+$/.test(options.memberId)) throw new Error('invalid member id');
  if (!/^[a-zA-Z0-9_-]+$/.test(options.legacyIdentity) || options.legacyIdentity === NEXT_IDENTITY) {
    throw new Error('legacy identity must be a distinct fixed marker');
  }
  return options;
}

// curl keeps the legacy probe's browser-compatible TLS handshake. No curlrc,
// proxy, cookie jar, retries, -k or -L; HTTP failures are measured, not swallowed.
// --resolve pins the measured DNS answers without changing TLS SNI/verification.
// Sources: https://curl.se/docs/manpage.html#--resolve and #--disable
export async function curlRequest(url, addresses, { connectTo, caFile, timeout = 15 } = {}) {
  const parsed = new URL(url);
  const dir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'cutover-'));
  try {
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const args = ['-q', '--silent', '--show-error', '--noproxy', '*', '--proto', '=http,https',
      '--connect-timeout', String(timeout), '--max-time', String(timeout), '--max-filesize', '2097152',
      '--user-agent', 'Mozilla/5.0 TWO-cutover-check', '--dump-header', join(dir, 'headers'),
      '--output', join(dir, 'body'), '--write-out', '%{json}'];
    if (connectTo) args.push('--connect-to', `${parsed.hostname}:${port}:127.0.0.1:${connectTo}`);
    else args.push('--resolve', `${parsed.hostname}:${port}:${addresses.map(ip => isIP(ip) === 6 ? `[${ip}]` : ip).join(',')}`);
    if (caFile) args.push('--cacert', caFile); // local TLS fixture seam, not a CLI flag
    args.push('--url', url);
    const { stdout } = await exec('curl', args, { timeout: (timeout + 2) * 1000, maxBuffer: 65536 });
    const meta = JSON.parse(stdout);
    const blocks = (await readFile(join(dir, 'headers'), 'utf8')).trim().split(/\r?\n\r?\n/);
    const headers = {};
    for (const line of blocks.at(-1).split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
    return { status: meta.http_code, headers, body: await readFile(join(dir, 'body'), 'utf8'),
      tlsVerified: parsed.protocol === 'https:' && meta.ssl_verify_result === 0, remoteIp: meta.remote_ip };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Independent resolver, bounded and injectable; ENODATA is an absent family,
// not an outage. SERVFAIL/timeouts/REFUSED are fatal even if the other family works.
// Source: https://nodejs.org/docs/latest-v24.x/api/dns.html#class-dnspromisesresolver
export async function dnsAnswers(name, resolver) {
  const answers = await Promise.all(['resolve4', 'resolve6'].map(async method => {
    try { return await resolver[method](name); }
    catch (err) { if (err.code === 'ENODATA') return []; throw err; }
  }));
  return [...new Set(answers.flat())];
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => {
    const attrs = {};
    for (const attr of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    }
    return attrs;
  });
}
const xmlText = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function absoluteOn(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
const noindex = value => /\b(?:noindex|none)\b/i.test(value ?? '');

export async function runChecks(options, { resolver = new Resolver({ timeout: 3000, tries: 1 }),
  request = curlRequest, freeze = null } = {}) {
  const checks = [];
  const record = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const markdown = freeze ?? await readFile(freezeFile, 'utf8');
  const uncovered = uncoveredFrozenPaths(markdown);
  record('url-freeze-coverage', uncovered.length === 0, uncovered.length ? `unmapped: ${uncovered.join(', ')}` : 'all frozen patterns mapped');
  const addresses = new Map();
  for (const name of new Set([options.target, options.apex, `www.${options.apex}`])) {
    try {
      const ips = await dnsAnswers(name, resolver);
      addresses.set(name, ips);
      record(`dns:${name}`, ips.length > 0, ips.join(', ') || 'no A/AAAA answers');
      if (name === options.target && options.expectedIps.length) {
        record(`dns-expected:${name}`, ips.length > 0 && ips.every(ip => options.expectedIps.includes(ip)),
          'every returned target address must belong to --expect-ip allowlist');
      }
    } catch (err) { record(`dns:${name}`, false, err.code ?? err.message); }
  }
  const cache = new Map();
  const probe = async url => {
    if (cache.has(url)) return cache.get(url);
    const name = new URL(url).hostname;
    let response = null;
    try {
      const ips = addresses.get(name);
      if (!ips?.length) throw new Error('no verified DNS answers');
      response = await request(url, ips);
      if (new URL(url).protocol === 'https:') record(`tls:${url}`, response.tlsVerified, 'certificate chain and hostname verification');
    } catch (err) { record(`transport:${url}`, false, `probe failed (${err.code ?? err.name})`); }
    cache.set(url, response);
    return response;
  };
  const origin = `https://${options.target}`;
  const apex = `https://${options.apex}`;
  const up = await probe(`${origin}/up`);
  record('target-origin', up?.status === 200 && up.headers[ORIGIN_HEADER] === NEXT_IDENTITY,
    `expected 200 + ${ORIGIN_HEADER}: ${NEXT_IDENTITY}`);
  record('target-up-no-store', /\bno-store\b/i.test(up?.headers['cache-control'] ?? ''), 'identity response must not be cached');
  const apexUp = await probe(`${apex}/up`);
  const expectedIdentity = options.phase === 'before' ? options.legacyIdentity : NEXT_IDENTITY;
  record('apex-origin', apexUp?.status === 200 && apexUp.headers[ORIGIN_HEADER] === expectedIdentity,
    `expected 200 + ${ORIGIN_HEADER}: ${expectedIdentity}; missing is not proof of legacy`);
  const apexHome = await probe(`${apex}/`);
  record('apex-home', apexHome?.status === 200, 'apex HTTPS must serve directly, not loop/redirect');
  const redirectPath = '/about?cutover=1';
  for (const base of [`http://${options.apex}`, `http://www.${options.apex}`, `https://www.${options.apex}`]) {
    const response = await probe(`${base}${redirectPath}`);
    record(`edge-redirect:${base}`, [301, 308].includes(response?.status) &&
      response.headers.location === `${apex}${redirectPath}`, 'single permanent hop to HTTPS apex, preserving path/query');
  }
  const sitemap = await probe(`${origin}/sitemap_index.xml`);
  const locs = [...(sitemap?.body ?? '').matchAll(/<loc\b[^>]*>([^<]+)<\/loc>/gi)].map(match => xmlText(match[1].trim()));
  record('sitemap', sitemap?.status === 200 && /<urlset\b/i.test(sitemap.body) && locs.length > 0 &&
    locs.every(url => absoluteOn(url, origin)), 'nonempty urlset, every loc absolute HTTPS on target host');
  let eventKey = options.eventKey;
  if (!eventKey) {
    const event = locs.find(url => absoluteOn(url, origin) && /^\/e\/[\w-]+$/.test(new URL(url).pathname));
    if (event) eventKey = new URL(event).pathname.slice(3);
  }
  record('published-event-fixture', Boolean(eventKey), 'use a published sitemap event or --event-key; never skip a frozen pattern');
  const robots = await probe(`${origin}/robots.txt`);
  const robotsSitemaps = [...(robots?.body ?? '').matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map(match => match[1]);
  record('robots-sitemap', robots?.status === 200 && robotsSitemaps.length > 0 &&
    robotsSitemaps.every(url => url === `${origin}/sitemap_index.xml`), 'robots sitemap advertises the target origin');
  // Before: X-Robots-Tag on each public HTML page is the indexing guard; the
  // app intentionally keeps robots crawlable so crawlers can observe noindex.
  record('robots-after-crawlable', options.phase === 'before' || !/^\s*Disallow:\s*\/\s*$/im.test(robots?.body ?? ''),
    'after cutover robots must not globally disallow crawling');
  for (const row of URL_CASES) {
    if (row.path.includes('{key}') && !eventKey) {
      record(`url:${row.path}`, false, 'published event key missing');
      continue;
    }
    const path = row.path.replace('{key}', eventKey).replace('{user}', options.memberId);
    const url = `${origin}${path}`;
    const response = await probe(url);
    record(`url:${path}`, response?.status === row.status, `expected ${row.status}, received ${response?.status ?? 'no response'}`);
    if (!response) continue;
    if (row.redirect) {
      let location;
      try { location = new URL(response.headers.location, url); } catch { /* fails below */ }
      let ok = false;
      if (row.redirect === 'invite') {
        ok = location?.protocol === 'https:' && !location.username && !location.password &&
          ((location.hostname === 'discord.gg' && /^\/[\w-]+$/.test(location.pathname)) ||
          (location.hostname === 'discord.com' && /^\/invite\/[\w-]+$/.test(location.pathname)));
        record('discord-no-store', /\bno-store\b/i.test(response.headers['cache-control'] ?? ''), 'invite must not be cached');
      } else if (row.redirect === 'oauth') {
        const callback = path.startsWith('/join') ? '/join/callback' : '/auth/discord/callback';
        ok = location?.origin === 'https://discord.com' && location.pathname === '/oauth2/authorize' &&
          location.searchParams.get('redirect_uri') === `${origin}${callback}`;
      } else ok = location?.href === `${origin}${row.redirect}`;
      record(`location:${path}`, ok, `expected ${row.redirect} redirect (not followed)`);
    }
    if (row.html) {
      record(`html:${path}`, /\btext\/html\b/i.test(response.headers['content-type'] ?? ''), 'HTML, not a JSON/challenge status substitute');
      const canonicals = tags(response.body, 'link').filter(tag => tag.rel?.toLowerCase() === 'canonical');
      record(`canonical:${path}`, canonicals.length === 1 && canonicals[0].href === url,
        'one absolute self-canonical on target host');
      const metas = tags(response.body, 'meta').filter(tag => ['robots', 'googlebot', 'bingbot'].includes(tag.name?.toLowerCase()));
      const blocked = noindex(response.headers['x-robots-tag']) || metas.some(tag => noindex(tag.content));
      const shouldIndex = options.phase === 'after' && row.indexable;
      record(`indexing:${path}`, shouldIndex ? !blocked : blocked, shouldIndex ? 'indexable after flip' : 'must be noindex');
      if (options.phase === 'before') record(`preview-header:${path}`, noindex(response.headers['x-robots-tag']), 'preview HTML needs X-Robots-Tag noindex');
    }
  }
  return { phase: options.phase, target: options.target, ok: checks.every(check => check.ok), checks };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runChecks(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`cutover-check: ${result.phase} ${result.target}`);
      for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`);
      console.log(`${result.checks.filter(check => !check.ok).length} failure(s); no DNS/configuration changes executed`);
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(`cutover-check: ${err.message}\nUsage: node ci/cutover-check.mjs --phase before|after --target <host> [--event-key <published-key>] [--expect-ip <ip>] [--json]`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
