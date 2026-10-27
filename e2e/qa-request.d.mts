export function transportFailureReason(error: unknown, token?: string): string;
export function sendTokenRequest<T>(
  label: string,
  token: string | undefined,
  send: () => Promise<T>,
): Promise<T>;

export type TokenFetchResponse = {
  status: number;
  headers: {
    get(name: string): string | null;
    getSetCookie(): string[];
  };
  body?: { cancel(): Promise<void> } | null;
};

export function fetchTokenRequest(
  label: string,
  token: string | undefined,
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): Promise<TokenFetchResponse>;

export type StorageStateCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

export function parseSetCookie(header: string, origin: string): StorageStateCookie | null;
export const QA_SESSION_COOKIE: "__Host-two_session";
export function qaLogin(options: {
  origin: string;
  identity: string;
  token: string;
  header: string;
}): Promise<{ cookies: StorageStateCookie[]; origins: [] }>;
