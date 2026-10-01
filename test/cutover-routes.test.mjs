import { expect, it } from 'vitest';
import app from '../src/index';
import { parseArgs, runChecks } from '../ci/cutover-check.mjs';

const leaves = ['/about', '/faq', '/rules', '/privacy'];
const retiredDiagnostics = ['/health', '/healthz', '/db-ping'];

for (const phase of ['before', 'after']) {
  it(`${phase} URL gates accept actual retired diagnostic 404s without database bindings`, async () => {
    const target = phase === 'before' ? 'next.togetherweown.com' : 'togetherweown.com';
    const options = parseArgs(['--phase', phase, '--target', target, '--event-key', 'fixture']);
    const env = { APP_URL: `https://${target}` };
    const seen = [];
    const result = await runChecks(options, {
      resolver: { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] },
      request: async url => {
        const parsed = new URL(url);
        if (parsed.hostname !== target || !retiredDiagnostics.includes(parsed.pathname)) {
          return { status: 404, headers: {}, body: '', tlsVerified: true };
        }
        seen.push(parsed.pathname);
        const response = await app.request(url, {}, env);
        expect(response.status).toBe(404);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        return { status: response.status, headers: Object.fromEntries(response.headers),
          body: await response.text(), tlsVerified: true };
      },
    });
    // Unrelated gates deliberately fail; all three diagnostic gates must exist and pass.
    expect(seen.sort()).toEqual([...retiredDiagnostics].sort());
    const diagnosticChecks = result.checks.filter(check => retiredDiagnostics.some(path => check.id === `url:${path}`));
    expect(diagnosticChecks).toHaveLength(retiredDiagnostics.length);
    expect(diagnosticChecks.filter(check => !check.ok)).toEqual([]);
  });
}

// Feed the real DB-free route HTML into the gate; synthetic canonical markup
// must not conceal a missing tag in the application. No sockets or DB bindings.
for (const phase of ['before', 'after']) {
  it(`${phase} canonical/indexing gates accept actual static-leaf responses`, async () => {
    // These hosts are in-process request identities, never resolved or contacted.
    const target = phase === 'before' ? 'next.togetherweown.com' : 'togetherweown.com';
    const options = parseArgs(['--phase', phase, '--target', target, '--event-key', 'fixture']);
    const env = {
      APP_URL: `https://${target}`,
      DISCORD_CLIENT_ID: 'test', DISCORD_CLIENT_SECRET: 'test',
      DISCORD_GUILD_ID: 'test', DISCORD_INVITE_URL: 'https://discord.gg/test',
      DISCORD_BOT_TOKEN: 'test', SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long',
    };
    const seen = [];
    const result = await runChecks(options, {
      resolver: { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] },
      request: async url => {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.search || parsed.hostname !== target || !leaves.includes(parsed.pathname)) {
          return { status: 404, headers: {}, body: '', tlsVerified: true };
        }
        seen.push(parsed.pathname);
        const response = await app.request(url, {}, env);
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        return { status: response.status, headers: Object.fromEntries(response.headers),
          body: await response.text(), tlsVerified: true };
      },
    });
    // Other gates deliberately fail (this fixture only exercises the leaves).
    expect(seen.sort()).toEqual([...leaves].sort());
    const leafChecks = result.checks.filter(check => leaves.some(path =>
      ['canonical:', 'indexing:', 'preview-header:'].some(prefix => check.id === prefix + path)));
    expect(leafChecks).toHaveLength(leaves.length * (phase === 'before' ? 3 : 2));
    expect(leafChecks.filter(check => !check.ok)).toEqual([]);
  });
}
