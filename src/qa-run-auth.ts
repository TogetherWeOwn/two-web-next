// Qualification credentials are observable by candidate code. This verifier
// bounds honest admission; independent staging resource containment is still
// required. No route uses this module until the complete session adapter lands.
import { STAGING_APP_URL } from "./qa";

export const QA_RUN_ORIGIN = STAGING_APP_URL;
export const QA_RUN_LIFETIME_SECONDS = 1500;
export const QA_RUN_CLOCK_MARGIN_SECONDS = 30;
const MAX_UNIX_SECONDS = 253402300799;
const HEX = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const INTEGER = /^[1-9][0-9]{0,19}$/;
const RANDOM = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";
const CREDENTIAL = new RegExp(`^qa1\\.([a-f0-9]{64})\\.${RANDOM}$`);
const SESSION = new RegExp(`^q1s\\.([a-f0-9]{64})\\.${RANDOM}$`);
const STATUS = /^q1p\.([a-f0-9]{64})\.[a-f0-9]{64}$/;

export type QaRunDescriptor = readonly [
  "two.qa.run.v1",
  string,
  "TogetherWeOwn/two-web-next",
  string,
  string,
  string,
  string,
  string,
  string,
  "staging",
  typeof QA_RUN_ORIGIN,
  "candidate-qa-login",
];

export type QaRunVerifier = {
  schema: "two.qa.verifier.v1";
  descriptor: QaRunDescriptor;
  q: string;
  credentialSha256: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
};

export type QaRunContext = {
  verifier: QaRunVerifier;
  now: number;
  deadline: number;
};

export type QaRunClock = () => number | null;

// A detected backward step poisons this isolate's qualification clock. A cold
// isolate still depends on the platform clock staying within the 30s bound.
export function createQaRunClock(read = Date.now): QaRunClock {
  let highWater = 0;
  let failed = false;
  return () => {
    const millis = read();
    if (
      failed ||
      !Number.isSafeInteger(millis) ||
      millis <= 0 ||
      millis > MAX_UNIX_SECONDS * 1000 ||
      millis < highWater - 1000
    ) {
      failed = true;
      return null;
    }
    highWater = Math.max(highWater, millis);
    return highWater / 1000;
  };
}

const runtimeClock = createQaRunClock(() => Date.now());

export async function qaRunSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validQaRunDescriptor(value: unknown): value is QaRunDescriptor {
  if (!Array.isArray(value) || value.length !== 12 || !value.every((v) => typeof v === "string"))
    return false;
  return (
    value[0] === "two.qa.run.v1" &&
    INTEGER.test(value[1]!) &&
    value[2] === "TogetherWeOwn/two-web-next" &&
    INTEGER.test(value[3]!) &&
    SHA.test(value[4]!) &&
    SHA.test(value[5]!) &&
    SHA.test(value[6]!) &&
    INTEGER.test(value[7]!) &&
    INTEGER.test(value[8]!) &&
    value[9] === "staging" &&
    value[10] === QA_RUN_ORIGIN &&
    value[11] === "candidate-qa-login"
  );
}

export function qaRunCredentialDigest(
  descriptor: QaRunDescriptor,
  credential: string,
): Promise<string> {
  return qaRunSha256(`two.qa.credential.v1\0${JSON.stringify(descriptor)}\0${credential}`);
}

export async function parseQaRunVerifier(raw: unknown): Promise<QaRunVerifier | null> {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // The trusted issuer emits compact JSON. Round-trip equality also refuses
  // duplicate/escaped keys, alternate number encodings and ambiguous strings.
  if (JSON.stringify(value) !== raw) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "credentialSha256,descriptor,expiresAt,issuedAt,notBefore,q,schema") return null;
  if (
    v.schema !== "two.qa.verifier.v1" ||
    !validQaRunDescriptor(v.descriptor) ||
    typeof v.q !== "string" ||
    !HEX.test(v.q) ||
    typeof v.credentialSha256 !== "string" ||
    !HEX.test(v.credentialSha256)
  )
    return null;
  const { issuedAt, notBefore, expiresAt } = v;
  if (
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt <= 0 ||
    notBefore !== issuedAt ||
    expiresAt > MAX_UNIX_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > QA_RUN_LIFETIME_SECONDS
  )
    return null;
  if ((await qaRunSha256(JSON.stringify(v.descriptor))) !== v.q) return null;
  return Object.freeze({
    schema: "two.qa.verifier.v1",
    descriptor: Object.freeze([...v.descriptor]) as QaRunDescriptor,
    q: v.q,
    credentialSha256: v.credentialSha256,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
  });
}

export function qaRunRequestOrigin(requestUrl: string, appUrl: string): boolean {
  if (appUrl !== QA_RUN_ORIGIN || !requestUrl.startsWith(`${QA_RUN_ORIGIN}/`)) return false;
  try {
    const url = new URL(requestUrl);
    return url.origin === QA_RUN_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function qaRunContext(
  raw: unknown,
  requestUrl: string,
  appUrl: string,
  clock: QaRunClock = runtimeClock,
): Promise<QaRunContext | null> {
  // Actual request origin is independent of configured APP_URL and headers.
  if (!qaRunRequestOrigin(requestUrl, appUrl)) return null;
  const verifier = await parseQaRunVerifier(raw);
  if (!verifier) return null;
  const now = clock();
  const deadline = verifier.expiresAt - QA_RUN_CLOCK_MARGIN_SECONDS;
  if (
    now === null ||
    !Number.isFinite(now) ||
    now <= 0 ||
    now > MAX_UNIX_SECONDS ||
    now < verifier.issuedAt - QA_RUN_CLOCK_MARGIN_SECONDS ||
    now >= deadline
  )
    return null;
  return { verifier, now, deadline };
}

export function qaRunNamespaceMatches(
  value: string,
  kind: "credential" | "session" | "status",
  q: string,
): boolean {
  const pattern = kind === "credential" ? CREDENTIAL : kind === "session" ? SESSION : STATUS;
  return pattern.exec(value)?.[1] === q;
}

export async function qaRunCredentialMatches(
  context: QaRunContext,
  presented: string,
): Promise<boolean> {
  if (!qaRunNamespaceMatches(presented, "credential", context.verifier.q)) return false;
  const digest = await qaRunCredentialDigest(context.verifier.descriptor, presented);
  const expected = context.verifier.credentialSha256;
  let diff = 0;
  for (let index = 0; index < 64; index++)
    diff |= digest.charCodeAt(index) ^ expected.charCodeAt(index);
  return diff === 0;
}
