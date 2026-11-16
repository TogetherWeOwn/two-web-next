export class KitLockAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions);
}

export function refuse(message: string, cause?: unknown): never;
export function guard<T>(label: string, operation: () => T): T;
export function checkAdmissionInput(
  env: { platform: string; nodeVersion: string },
  path: unknown,
): void;
