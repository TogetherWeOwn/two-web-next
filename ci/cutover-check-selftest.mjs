// Every socket is loopback. DNS is a stub, never the machine's resolver.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { curlRequest, dnsAnswers, NEXT_IDENTITY, ORIGIN_HEADER, parseArgs,
  runChecks, uncoveredFrozenPaths, URL_CASES, xmlText } from './cutover-check.mjs';

const exec = promisify(execFile);
const apex = 'example.test';
const candidate = 'next.example.test';
const eventKey = 'cutover-event';
const freeze = await readFile(new URL('../docs/url-freeze.md', import.meta.url), 'utf8');
const options = phase => parseArgs(['--phase', phase, '--target', phase === 'before' ? candidate : apex, '--apex', apex]);
const noData = () => Object.assign(new Error('no records'), { code: 'ENODATA' });
const stubDns = () => ({
  calls: [],
  async resolve4(name) { this.calls.push(['A', name]); return ['127.0.0.1']; },
  async resolve6(name) { this.calls.push(['AAAA', name]); throw noData(); },
});

function fixture(url, phase) {
  const { hostname, pathname, search, origin, protocol } = new URL(url);
  const path = pathname + search;
  const target = phase === 'before' ? candidate : apex;
  const headers = {};
  if (hostname === `www.${apex}` || protocol === 'http:') {
    return { status: 301, headers: { location: `https://${apex}${path}` }, body: '' };
  }
  if (pathname === '/up') {
    headers[ORIGIN_HEADER] = hostname === target ? NEXT_IDENTITY : 'two-web';
    headers['cache-control'] = 'no-store';
    return { status: 200, headers, body: '{"status":"healthy","queue":{"status":"unknown"}}' };
  }
  if (hostname === apex && phase === 'before') {
    return { status: 200, headers: { 'content-type': 'text/html' }, body: '<h1>legacy</h1>' };
  }
  const row = URL_CASES.find(row => row.path.replace('{key}', eventKey).replace('{user}', '0') === path);
  assert.ok(row, `unrecognised fixture URL ${url}`);
  // Pin the retired diagnostic contract independently of the checker table.
  const response = { status: ['/health', '/healthz', '/db-ping'].includes(path) ? 404 : row.status, headers, body: '' };
  if (pathname === '/sitemap_index.xml') {
    headers['content-type'] = 'application/xml';
    response.body = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/e/${eventKey}</loc></url></urlset>`;
  } else if (pathname === '/robots.txt') {
    headers['content-type'] = 'text/plain';
    response.body = `User-agent: *\nDisallow:\nSitemap: ${origin}/sitemap_index.xml\n`;
  }
  if (row.html) {
    headers['content-type'] = 'text/html; charset=UTF-8';
    if (phase === 'before') headers['x-robots-tag'] = 'noindex, nofollow';
    response.body = `<html><head><link href='${url}' rel='canonical'>${!row.indexable ? '<meta content="noindex, follow" name="robots">' : ''}</head><body>fixture</body></html>`;
  }
  if (row.redirect === 'invite') {
    headers.location = 'https://discord.gg/cutover';
    headers['cache-control'] = 'no-store, private';
  } else if (row.redirect === 'oauth') {
    const callback = pathname.startsWith('/join') ? '/join/callback' : '/auth/discord/callback';
    headers.location = `https://discord.com/oauth2/authorize?redirect_uri=${encodeURIComponent(origin + callback)}`;
  } else if (row.redirect) headers.location = row.redirect;
  return response;
}

async function withServer(phase, callback, mutate = () => {}) {
  const urls = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    const url = req.headers['x-fixture-url'];
    const response = fixture(url, phase);
    mutate(url, response);
    urls.push(url);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const request = async (url, ips) => {
      // Real curl HTTP request to the fixture. The fake URL is passed separately
      // so the server can model TLS/scheme/Host contracts without a live domain.
      const parsed = new URL(url);
      const result = await exec('curl', ['-q', '--silent', '--show-error', '--noproxy', '*',
        '--max-time', '3', '--dump-header', '-', '--header', `X-Fixture-Url: ${url}`,
        `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`]);
      const split = result.stdout.indexOf('\r\n\r\n');
      const lines = result.stdout.slice(0, split).split('\r\n');
      const headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      assert.deepEqual(ips, ['127.0.0.1']);
      return { status: Number(lines[0].split(' ')[1]), headers, body: result.stdout.slice(split + 4),
        tlsVerified: url.startsWith('https:'), remoteIp: '127.0.0.1' };
    };
    await callback({ request, resolver: stubDns(), freeze, urls, port });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

for (const phase of ['before', 'after']) {
  test(`${phase} passes with HTTP/DNS stubs and measures every frozen URL`, async () => {
    await withServer(phase, async dependencies => {
      const result = await runChecks(options(phase), dependencies);
      assert.deepEqual(result.checks.filter(check => !check.ok), []);
      assert.equal(result.ok, true);
      const origin = `https://${options(phase).target}`;
      for (const row of URL_CASES) {
        assert.ok(dependencies.urls.includes(origin + row.path.replace('{key}', eventKey).replace('{user}', '0')), row.path);
      }
      for (const [, name] of dependencies.resolver.calls) assert.ok([apex, candidate, `www.${apex}`].includes(name));
    });
  });
}

test('retired diagnostics reject soft-404s and redirects in both phases', async () => {
  for (const phase of ['before', 'after']) {
    for (const path of ['/health', '/healthz', '/db-ping']) {
      for (const status of [200, 302]) {
        const result = await runChecks(options(phase), {
          freeze, resolver: stubDns(), request: async url => {
            const response = fixture(url, phase);
            if (new URL(url).hostname === options(phase).target && new URL(url).pathname === path) {
              response.status = status;
              response.headers.location = '/up';
            }
            return { ...response, tlsVerified: true };
          },
        });
        assert.equal(result.ok, false, `${phase} ${path} ${status}`);
        assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.id), [`url:${path}`]);
      }
    }
  }
});

test('freeze mapping rejects newly documented paths instead of silently skipping them', () => {
  assert.deepEqual(uncoveredFrozenPaths(freeze), []);
  assert.deepEqual(uncoveredFrozenPaths(freeze + '\n| `/new-frozen-route` | owner |\n'), ['/new-frozen-route']);
});

test('sitemap XML entities are decoded exactly once', () => {
  assert.equal(xmlText('https://example.test/?a=1&amp;b=2'), 'https://example.test/?a=1&b=2');
  assert.equal(xmlText('&amp;quot;&amp;lt;&amp;apos;'), '&quot;&lt;&apos;');
  assert.equal(xmlText('&quot;&lt;&gt;&apos;'), '"<>\'');
});

test('DNS empty-family vs failure, complete failure and empty answers', async () => {
  assert.deepEqual(await dnsAnswers(apex, stubDns()), ['127.0.0.1']);
  for (const code of ['ESERVFAIL', 'ETIMEOUT', 'EREFUSED', 'ENOTFOUND']) {
    const resolver = stubDns();
    resolver.resolve6 = async () => { throw Object.assign(new Error('dns failed'), { code }); };
    const result = await runChecks(options('after'), { resolver, request: async () => assert.fail('no requests without DNS'), freeze });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some(check => check.id === `dns:${apex}` && !check.ok && check.detail === code));
  }
  const resolver = { resolve4: async () => [], resolve6: async () => [] };
  assert.equal((await runChecks(options('after'), { resolver, request: async () => assert.fail('empty DNS'), freeze })).ok, false);
});

test('all regressions fail closed, including wrong phase and challenge/soft-404 responses', async () => {
  const regressions = [
    ['missing identity', 'after', '/up', response => { delete response.headers[ORIGIN_HEADER]; }, 'target-origin'],
    ['legacy after flip', 'after', '/up', response => { response.headers[ORIGIN_HEADER] = 'two-web'; }, 'apex-origin'],
    ['Next before flip', 'before', '/up', response => { response.headers[ORIGIN_HEADER] = NEXT_IDENTITY; }, 'apex-origin'],
    ['cached health', 'after', '/up', response => { delete response.headers['cache-control']; }, 'target-up-no-store'],
    ['noindex after', 'after', '/about', response => { response.headers['x-robots-tag'] = 'googlebot: noindex'; }, 'indexing:/about'],
    ['indexable preview', 'before', '/about', response => { delete response.headers['x-robots-tag']; }, 'preview-header:/about'],
    ['foreign canonical', 'after', '/about', response => { response.body = '<link rel="canonical" href="https://foreign.test/about">'; }, 'canonical:/about'],
    ['duplicate canonical', 'after', '/about', response => { response.body += response.body; }, 'canonical:/about'],
    ['foreign sitemap', 'after', '/sitemap_index.xml', response => { response.body = response.body.replaceAll(apex, 'foreign.test'); }, 'sitemap'],
    ['empty sitemap', 'after', '/sitemap_index.xml', response => { response.body = '<urlset></urlset>'; }, 'sitemap'],
    ['no published event', 'after', '/sitemap_index.xml', response => { response.body = `<urlset><url><loc>https://${apex}/</loc></url></urlset>`; }, 'published-event-fixture'],
    ['robots blocked', 'after', '/robots.txt', response => { response.body += 'Disallow: /\n'; }, 'robots-after-crawlable'],
    ['wrong robots host', 'after', '/robots.txt', response => { response.body = response.body.replaceAll(apex, candidate); }, 'robots-sitemap'],
    ['wrong invite', 'after', '/discord', response => { response.headers.location = 'https://discord.com/oauth2/authorize'; }, 'location:/discord'],
    ['wrong callback host', 'after', '/join/discord', response => { response.headers.location = response.headers.location.replace(encodeURIComponent(apex), encodeURIComponent(candidate)); }, 'location:/join/discord'],
    ['soft-404', 'after', '/news/', response => { response.status = 200; }, 'url:/news/'],
    ['challenge', 'after', '/about', response => { response.status = 403; }, 'url:/about'],
    ['missing Location', 'after', '/discord', response => { delete response.headers.location; }, 'location:/discord'],
  ];
  for (const [label, phase, path, change, id] of regressions) {
    await withServer(phase, async dependencies => {
      const result = await runChecks(options(phase), dependencies);
      assert.equal(result.ok, false, label);
      assert.ok(result.checks.some(check => check.id === id && !check.ok), label);
    }, (url, response) => { if (new URL(url).pathname === path) change(response); });
  }
});

test('wrong TLS, transport errors and wrong edge redirects are failures', async () => {
  for (const failure of ['tls', 'transport', 'redirect']) {
    const result = await runChecks(options('after'), {
      resolver: stubDns(), freeze,
      request: async url => {
        if (failure === 'transport') throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        const response = fixture(url, 'after');
        if (failure === 'redirect' && new URL(url).hostname.startsWith('www.')) response.headers.location = `https://${apex}/`;
        return { ...response, tlsVerified: failure !== 'tls' };
      },
    });
    assert.equal(result.ok, false, failure);
    assert.ok(result.checks.some(check => !check.ok && check.id.startsWith({ tls: 'tls:', transport: 'transport:', redirect: 'edge-redirect:' }[failure])));
  }
});

test('every A/AAAA address gets separate identity, TLS and HTTP verdicts with per-address caching', async () => {
  const ips = ['127.0.0.1', '127.0.0.2', '::1'];
  for (const failure of ['identity', 'tls', 'http', 'transport']) {
    const calls = new Map();
    const result = await runChecks(options('after'), {
      freeze, resolver: { resolve4: async () => ips.slice(0, 2), resolve6: async () => ips.slice(2) },
      request: async (url, addresses) => {
        assert.equal(addresses.length, 1);
        const [ip] = addresses;
        const key = `${url}@${ip}`;
        calls.set(key, (calls.get(key) ?? 0) + 1);
        const response = { ...fixture(url, 'after'), tlsVerified: true, remoteIp: ip };
        if (ip === '::1') {
          if (failure === 'transport') throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
          if (failure === 'tls') response.tlsVerified = false;
          if (failure === 'identity' && new URL(url).pathname === '/up') response.headers[ORIGIN_HEADER] = 'two-web';
          if (failure === 'http' && new URL(url).pathname === '/about') response.status = 503;
        }
        return response;
      },
    });
    assert.equal(result.ok, false, failure);
    const id = { identity: 'target-origin', tls: `tls:https://${apex}/up`, http: 'url:/about', transport: `transport:https://${apex}/up` }[failure];
    assert.ok(result.checks.some(check => check.id === id && check.address === '::1' && !check.ok), failure);
    for (const ip of ips) {
      for (const row of URL_CASES) {
        const url = `https://${apex}${row.path.replace('{key}', eventKey).replace('{user}', '0')}`;
        assert.equal(calls.get(`${url}@${ip}`), 1, `${failure}: ${url}@${ip}`);
      }
    }
    assert.ok([...calls.values()].every(count => count === 1), 'no repeated transfers for reused /up, sitemap or robots');
  }
});

test('mixed good/legacy loopback DNS answers cannot hide behind the first address', async () => {
  const servers = [];
  const hits = [0, 0];
  try {
    for (const [index, ip] of ['127.0.0.1', '127.0.0.2'].entries()) {
      const server = createServer((_req, res) => {
        hits[index]++;
        res.writeHead(200, { [ORIGIN_HEADER]: index === 0 ? NEXT_IDENTITY : 'two-web', 'cache-control': 'no-store' });
        res.end('{}');
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(index === 0 ? 0 : servers[0].address().port, ip, resolve);
      });
    }
    const port = servers[0].address().port;
    const result = await runChecks(options('after'), {
      freeze, resolver: { resolve4: async () => ['127.0.0.1', '127.0.0.2'], resolve6: async () => [] },
      request: async (url, ips) => {
        if (new URL(url).pathname === '/up') {
          const response = await curlRequest(`http://${apex}:${port}/up`, ips, { timeout: 2 });
          return { ...response, tlsVerified: true }; // TLS is covered separately by the trusted-certificate fixture.
        }
        return { ...fixture(url, 'after'), tlsVerified: true };
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(hits, [1, 1]);
    assert.ok(result.checks.some(check => check.id === 'target-origin' && check.address === '127.0.0.1' && check.ok));
    assert.ok(result.checks.some(check => check.id === 'target-origin' && check.address === '127.0.0.2' && !check.ok));
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('robots parsing respects comments, wildcard paths, crawler groups and allow precedence', async () => {
  const cases = [
    ['Disallow: /*', false],
    ['Disallow: / # maintenance', false],
    ['Disallow: /*$', false],
    ['Disallow: /\nAllow: /about', false], // a leaf exception cannot hide a blocked homepage
    ['Disallow: /about$', false],
    ['Disallow: /%61bout$', false],
    ['Disallow: /%2Fabout$', true],
    ['Disallow: /private/\nAllow: /private/public/', true],
    ['Disallow: /\nAllow: /', true],
    ['Disallow: /about/child$', true],
    ['User-agent: unrelatedbot\nDisallow: /', true],
    ['User-agent: Googlebot\nDisallow: /', false],
    ['User-agent: unrelatedbot\nDisallow: /\nUser-agent: *\nDisallow:', true],
    ['Disallow:\nUser-agent: *\nDisallow: /*', false], // repeated matching groups combine
    ['Disallow: /about\nAllow: /about$', true],
  ];
  for (const [rules, expected] of cases) {
    const result = await runChecks(options('after'), {
      freeze, resolver: stubDns(), request: async url => {
        const response = fixture(url, 'after');
        if (new URL(url).pathname === '/robots.txt') response.body = `User-agent: *\nDisallow:\n${rules}\nSitemap: https://${apex}/sitemap_index.xml # sitemap comment\n`;
        return { ...response, tlsVerified: true };
      },
    });
    assert.equal(result.ok, expected, rules);
    assert.equal(result.checks.find(check => check.id === 'robots-after-crawlable').ok, expected, rules);
  }
});

test('indexing parses directive names and preserves header and crawler scope', async () => {
  const cases = [
    ['before', 'max-image-preview: none', '', false],
    ['before', 'googlebot: noindex', '', false],
    ['before', 'googlebot: nofollow, noindex', '', false],
    ['before', 'googlebot: nofollow, none', '', false],
    ['before', 'max-image-preview: none, noindex', '', true],
    ['before', 'NONE', '', true],
    ['before', ['googlebot: noindex', 'noindex, nofollow'], '', true],
    ['before', 'googlebot: noindex', '<meta name="robots" content="noindex">', false],
    ['after', 'max-image-preview: none', '', true],
    ['after', 'max-snippet: 0, max-image-preview: none', '', true],
    ['after', 'googlebot: noindex', '', false],
    ['after', 'googlebot: none', '', false],
    ['after', '', '<meta name="robots" content="max-image-preview: none">', true],
    ['after', '', '<meta name="googlebot-news" content="noindex">', false],
    ['after', '', '<meta name="bingbot" content="none">', false],
  ];
  for (const [phase, header, meta, expected] of cases) {
    const result = await runChecks(options(phase), {
      freeze, resolver: stubDns(), request: async url => {
        const response = fixture(url, phase);
        if (new URL(url).hostname === options(phase).target && new URL(url).pathname === '/about') {
          response.headers['x-robots-tag'] = header;
          response.body += meta;
        }
        return { ...response, tlsVerified: true };
      },
    });
    assert.equal(result.ok, expected, `${phase}: ${JSON.stringify(header)} ${meta}`);
    if (phase === 'before') assert.equal(result.checks.find(check => check.id === 'preview-header:/about').ok, expected);
    else assert.equal(result.checks.find(check => check.id === 'indexing:/about').ok, expected);
  }
});

test('real curl transport pins loopback, parses headers, does not follow and rejects invalid TLS', async () => {
  const server = createServer((req, res) => {
    res.writeHead(302, { location: 'https://must-not-contact.example/', 'x-two-origin': NEXT_IDENTITY,
      'x-robots-tag': ['googlebot: noindex', 'noindex, nofollow'] });
    res.end('body');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await curlRequest(`http://${apex}:${port}/probe`, ['127.0.0.1'], { timeout: 1 });
    assert.equal(response.status, 302);
    assert.equal(response.headers[ORIGIN_HEADER], NEXT_IDENTITY);
    assert.deepEqual(response.headers['x-robots-tag'], ['googlebot: noindex', 'noindex, nofollow']);
    await assert.rejects(curlRequest(`http://${apex}:${port}/probe`, ['127.0.0.1', '127.0.0.2']), /exactly one DNS address/);
    assert.equal(response.body, 'body');
    assert.equal(response.tlsVerified, false);
    assert.equal(response.remoteIp, '127.0.0.1');
    await assert.rejects(curlRequest(`https://${apex}/probe`, ['127.0.0.1'], { connectTo: port, timeout: 1 }));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('real TLS requires a trusted certificate and matching hostname', async () => {
  const dir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'cutover-tls-'));
  let server;
  try {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${apex}`, '-addext', `subjectAltName=DNS:${apex}`,
      '-keyout', key, '-out', cert]);
    server = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
      res.writeHead(200, { [ORIGIN_HEADER]: NEXT_IDENTITY });
      res.end('TLS fixture');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `https://${apex}:${port}/up`;
    await assert.rejects(curlRequest(url, ['127.0.0.1'], { timeout: 2 }), 'untrusted certificate');
    const response = await curlRequest(url, ['127.0.0.1'], { caFile: cert, timeout: 2 });
    assert.equal(response.tlsVerified, true);
    assert.equal(response.status, 200);
    await assert.rejects(curlRequest(`https://${candidate}:${port}/up`, ['127.0.0.1'], { caFile: cert, timeout: 2 }), 'wrong hostname');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI rejects unsafe/missing arguments before any network I/O', async () => {
  for (const argv of [[], ['--phase', 'sideways'], ['--phase', 'after', '--target', 'https://example.test'],
    ['--phase', 'after', '--target', candidate, '--apex', apex],
    ['--phase', 'before', '--target', candidate, '--event-key', '../admin'],
    ['--phase', 'before', '--target', candidate, '--expect-ip', 'example.test'],
    ['--phase', 'before', '--target', candidate, '--unknown', 'yes']]) assert.throws(() => parseArgs(argv));
  await assert.rejects(exec(process.execPath, ['ci/cutover-check.mjs', '--phase', 'invalid']), err => err.code === 2);
});
