export const QA_LOGIN_MAX_ATTEMPTS: number;
export const QA_LOGIN_RETRY_AFTER_CAP_SECONDS: number;
export function parseRetryAfterSeconds(
  headers: Record<string, string> | undefined,
  fallbackSeconds?: number,
): number;
export function qaLoginThrottleError(
  identity: string,
  retryAfterSeconds: number,
  attempts: number,
  scope?: string,
): Error;
export function sleep(ms: number): Promise<void>;
export function qaLoginRetryBudgetMs(loginCount: number): number;
