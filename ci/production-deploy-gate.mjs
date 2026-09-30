import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function assertProductionRequest(env) {
  if (env.PRODUCTION_DEPLOY_ENABLED !== 'true') {
    throw new Error('Production deployment disabled: repo variable PRODUCTION_DEPLOY_ENABLED must be exactly true');
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Production deployment requires workflow_dispatch on main');
  }
}

export function assertProductionProtection(environment) {
  const review = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (environment.name !== 'production' || !review?.reviewers?.length || review.prevent_self_review !== true) {
    throw new Error('production Environment must have required reviewers and prevent self-review');
  }
}

export function assertProductionTarget(configText) {
  if (/"id"\s*:\s*"0{32}"/.test(configText)) {
    throw new Error('Production Hyperdrive is still a placeholder; provision and review the cutover configuration first');
  }
}

export async function checkProductionGate(env, fetchEnvironment = fetch) {
  // Refuse before any API request, and before the protected deploy job can start.
  assertProductionRequest(env);
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('GitHub Environment protection cannot be verified');
  }
  const response = await fetchEnvironment(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/environments/production`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Cannot verify production Environment protection (HTTP ${response.status})`);
  }
  assertProductionProtection(await response.json());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkProductionGate(process.env);
    assertProductionTarget(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    console.log('Production dispatch, enable flag, review protection and target checks passed');
  } catch (error) {
    // Do not print request/response bodies or credentials on a failed API call.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
