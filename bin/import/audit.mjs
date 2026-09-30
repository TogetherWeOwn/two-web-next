#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

export function parseOptions(args) {
  const allowed = new Set(['--dry-run', '--apply', '--enable-grants', '--help']);
  if (args.some((arg) => !allowed.has(arg)) ||
      (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('invalid_options');
  }
  return {
    dryRun: !args.includes('--apply'),
    enableGrants: args.includes('--enable-grants'),
    help: args.includes('--help'),
  };
}

export function databaseConfig(env) {
  for (const name of ['LEGACY_DATABASE_URL', 'DATABASE_URL']) {
    if (!env[name]) throw new Error('missing_database_configuration');
    try {
      const url = new URL(env[name]);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error('invalid_database_configuration');
    }
  }
  const legacySchema = env.LEGACY_DATABASE_SCHEMA || 'public';
  const targetSchema = env.DATABASE_SCHEMA || 'public';
  for (const schema of [legacySchema, targetSchema]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid_schema');
  }
  if (env.LEGACY_DATABASE_URL === env.DATABASE_URL && legacySchema === targetSchema) {
    throw new Error('source_equals_target');
  }
  return { legacySchema, targetSchema };
}

// The database driver can include SQL values, URLs and server details in errors.
// Only a static message and an allowlisted SQLSTATE may leave this CLI.
export function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    ? ` (SQLSTATE ${error.code})` : '';
  return `Audit import failed${code}; no row data or connection details logged.`;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let legacy;
  let target;
  try {
    const options = parseOptions(args);
    if (options.help) {
      console.log('Usage: node bin/import/audit.mjs [--dry-run | --apply] [--enable-grants]');
      console.log('Connection URLs come only from LEGACY_DATABASE_URL and DATABASE_URL.');
      return 0;
    }
    const schemas = databaseConfig(env);
    const connectionOptions = { max: 1, onnotice: () => {} };
    legacy = postgres(env.LEGACY_DATABASE_URL, connectionOptions);
    target = postgres(env.DATABASE_URL, connectionOptions);
    const result = await importAudit({ legacy, target, ...schemas, ...options });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(safeFailure(error));
    return 1;
  } finally {
    await Promise.all([legacy?.end({ timeout: 5 }), target?.end({ timeout: 5 })]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
