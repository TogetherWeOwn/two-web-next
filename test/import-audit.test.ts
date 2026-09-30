import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_RETENTION_DAYS } from '../src/jobs/constants';

// The operator CLI is standalone JS, not part of the Workers TypeScript bundle.
// @ts-expect-error Standalone import tooling has no declaration file.
import { databaseConfig, parseOptions, safeFailure, validateGrant, IDEMPOTENCY_RETENTION_DAYS } from '../bin/import/audit.mjs';

const cli = fileURLToPath(new URL('../bin/import/audit.mjs', import.meta.url));

describe('audit import CLI (no credentials required)', () => {
  it('defaults to dry-run and disables imported grants', () => {
    expect(parseOptions([])).toEqual({ dryRun: true, enableGrants: false, help: false });
    expect(parseOptions(['--apply', '--enable-grants'])).toEqual({
      dryRun: false, enableGrants: true, help: false,
    });
  });

  it('pins retention to the existing policy and refuses raw verifier material', () => {
    expect(IDEMPOTENCY_RETENTION_DAYS).toBe(IDEMPOTENCY_KEY_RETENTION_DAYS);
    expect(() => validateGrant({ verifier_hash: 'a'.repeat(64) })).not.toThrow();
    for (const verifier_hash of ['synthetic-bearer', 'x'.repeat(64), null, 'a'.repeat(63)]) {
      expect(() => validateGrant({ verifier_hash })).toThrow('invalid_grant_digest');
    }
  });

  it('rejects unknown/credential arguments and contradictory modes', () => {
    for (const args of [['--url=postgres://secret'], ['postgres://secret'], ['--apply', '--dry-run']]) {
      expect(() => parseOptions(args)).toThrow('invalid_options');
    }
  });

  it('validates URLs and schema identifiers without exposing them', () => {
    expect(() => databaseConfig({})).toThrow('missing_database_configuration');
    expect(() => databaseConfig({ LEGACY_DATABASE_URL: 'secret', DATABASE_URL: 'secret' }))
      .toThrow('invalid_database_configuration');
    const env = {
      LEGACY_DATABASE_URL: 'postgres://agent_test@agent-testdb:5432/two_web_next',
      DATABASE_URL: 'postgres://agent_test@agent-testdb:5432/two_web_next',
    };
    expect(() => databaseConfig(env)).toThrow('source_equals_target');
    expect(databaseConfig({ ...env, LEGACY_DATABASE_SCHEMA: 'legacy' })).toEqual({
      legacySchema: 'legacy', targetSchema: 'public',
    });
    expect(() => databaseConfig({ ...env, LEGACY_DATABASE_SCHEMA: 'legacy; select 1' }))
      .toThrow('invalid_schema');
  });

  it('redacts raw driver errors, including SQL values and URLs', () => {
    const error = { code: '23505', message: 'bearer-secret postgres://password', query: 'secret' };
    expect(safeFailure(error)).toBe(
      'Audit import failed (SQLSTATE 23505); no row data or connection details logged.',
    );
    expect(safeFailure({ code: 'secret' })).not.toContain('secret');
  });

  it('prints safe help and fails closed without database configuration', () => {
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env: {} });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--dry-run');
    const failure = spawnSync(process.execPath, [cli, '--url=private-secret'], {
      encoding: 'utf8', env: {},
    });
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('Audit import failed');
    expect(failure.stderr).not.toContain('private-secret');
  });
});
