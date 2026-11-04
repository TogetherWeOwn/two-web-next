import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createQaRunClock,
  parseQaRunVerifier,
  QA_RUN_ORIGIN,
  qaRunContext,
  qaRunCredentialMatches,
  qaRunNamespaceMatches,
  qaRunRequestOrigin,
  type QaRunDescriptor,
} from "../src/qa-run-auth";

const ISSUED = Date.UTC(2026, 10, 4, 8) / 1000;
const descriptor: QaRunDescriptor = [
  "two.qa.run.v1",
  "123456",
  "TogetherWeOwn/two-web-next",
  "2035",
  "a".repeat(40),
  "b".repeat(40),
  "c".repeat(40),
  "456789",
  "1",
  "staging",
  QA_RUN_ORIGIN,
  "candidate-qa-login",
];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const q = sha(JSON.stringify(descriptor));
const nonce = Buffer.alloc(32, 7).toString("base64url");
const credential = `qa1.${q}.${nonce}`;
const verifier = {
  schema: "two.qa.verifier.v1",
  descriptor,
  q,
  credentialSha256: sha(`two.qa.credential.v1\0${JSON.stringify(descriptor)}\0${credential}`),
  issuedAt: ISSUED,
  notBefore: ISSUED,
  expiresAt: ISSUED + 1500,
};
const raw = JSON.stringify(verifier);
const url = `${QA_RUN_ORIGIN}/auth/qa/qa-member`;
const context = (now = ISSUED, binding: unknown = raw, requestUrl = url, appUrl = QA_RUN_ORIGIN) =>
  qaRunContext(binding, requestUrl, appUrl, () => now);

describe("per-run QA verifier admission (fixtures only)", () => {
  it("joins the independently computed canonical descriptor and credential digests", async () => {
    const parsed = await parseQaRunVerifier(raw);
    expect(parsed).toEqual(verifier);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.descriptor)).toBe(true);
    expect(await qaRunCredentialMatches((await context())!, credential)).toBe(true);
    expect(credential).toHaveLength(112);
  });

  it.each([
    undefined,
    null,
    "",
    "{",
    "[]",
    "null",
    "false",
    "0",
    JSON.stringify(raw),
    `${raw} `,
    raw.replace('"issuedAt":', '"issuedAt":0,"issuedAt":'),
    raw.replace('"q":', '"\\u0071":'),
    " ".repeat(4097),
    JSON.stringify({ ...verifier, padding: "é".repeat(4096) }),
    JSON.stringify({ ...verifier, extra: true }),
    JSON.stringify({ ...verifier, schema: "other" }),
    JSON.stringify({ ...verifier, credentialSha256: "A".repeat(64) }),
    JSON.stringify({ ...verifier, credentialSha256: 12 }),
    JSON.stringify({ ...verifier, q: "f".repeat(64) }),
    JSON.stringify({ ...verifier, q: null }),
    JSON.stringify({ ...verifier, notBefore: ISSUED - 1 }),
    JSON.stringify({ ...verifier, issuedAt: 0, notBefore: 0 }),
    JSON.stringify({ ...verifier, issuedAt: "0" }),
    JSON.stringify({ ...verifier, issuedAt: ISSUED + 0.5, notBefore: ISSUED + 0.5 }),
    JSON.stringify({ ...verifier, expiresAt: ISSUED }),
    JSON.stringify({ ...verifier, expiresAt: ISSUED + 1501 }),
    JSON.stringify({ ...verifier, expiresAt: Number.MAX_SAFE_INTEGER }),
    JSON.stringify({ ...verifier, expiresAt: null }),
    JSON.stringify({ ...verifier, descriptor: {} }),
    JSON.stringify({ ...verifier, descriptor: descriptor.slice(1) }),
  ])("refuses malformed, ambiguous or overlong binding %#", async (binding) => {
    expect(await parseQaRunVerifier(binding)).toBeNull();
    expect(await qaRunContext(binding, url, QA_RUN_ORIGIN, () => ISSUED)).toBeNull();
  });

  it("refuses every missing required field", async () => {
    for (const key of Object.keys(verifier)) {
      const missing = { ...verifier } as Record<string, unknown>;
      delete missing[key];
      expect(await parseQaRunVerifier(JSON.stringify(missing))).toBeNull();
    }
  });

  it.each([
    [0, "other"],
    [1, "01"],
    [1, "1;echo unsafe"],
    [2, "Other/repo"],
    [3, "0"],
    [3, 2035],
    [4, "A".repeat(40)],
    [5, "main"],
    [6, "c".repeat(39)],
    [7, "-1"],
    [8, "1.0"],
    [9, "production"],
    [10, "https://togetherweown.com"],
    [11, "alert-probe"],
  ])("refuses descriptor field %s = %s even with a matching q", async (index, value) => {
    const altered: unknown[] = [...descriptor];
    altered[index as number] = value;
    const binding = JSON.stringify({
      ...verifier,
      descriptor: altered,
      q: sha(JSON.stringify(altered)),
    });
    expect(await parseQaRunVerifier(binding)).toBeNull();
  });

  it.each([
    "https://togetherweown.com/",
    "https://www.togetherweown.com/",
    "https://preview.example/",
    "https://candidate.workers.dev/",
    "http://next.togetherweown.com/",
    "https://next.togetherweown.com:443/",
    "https://next.togetherweown.com:8443/",
    "https://next.togetherweown.com./",
    "https://NEXT.togetherweown.com/",
    "https://next.togetherweown.com.evil.example/",
    "https://next.togetherweown.com@evil.example/",
    "https://user:pass@next.togetherweown.com/",
    "https://next.togetherweown.com\\@evil.example/",
    "https://next.togetherweown.com",
    "not a URL",
  ])("refuses actual origin %s despite copied staging metadata and APP_URL", async (actual) => {
    const clock = vi.fn(() => ISSUED);
    expect(qaRunRequestOrigin(actual, QA_RUN_ORIGIN)).toBe(false);
    expect(await qaRunContext(raw, actual, QA_RUN_ORIGIN, clock)).toBeNull();
    expect(clock).not.toHaveBeenCalled();
  });

  it("independently requires the exact configured origin", async () => {
    expect(await context(ISSUED, raw, url, "https://togetherweown.com")).toBeNull();
    expect(await context(ISSUED, raw, url, `${QA_RUN_ORIGIN}/`)).toBeNull();
  });

  it.each([ISSUED - 31, ISSUED + 1470, ISSUED + 1500, NaN, Infinity, -Infinity])(
    "refuses admission at the time boundary %s",
    async (now) => expect(await context(now)).toBeNull(),
  );

  it("retains original expiry after early cancellation and lost cleanup", async () => {
    // This residual interval is explicitly authorized. Cancellation never
    // resets issuance; unchanged metadata stops admitting at E, not after GC.
    for (const now of [ISSUED - 30, ISSUED + 60, ISSUED + 1469.999]) {
      const active = await context(now);
      expect(active?.deadline).toBe(ISSUED + 1470);
      expect(await qaRunCredentialMatches(active!, credential)).toBe(true);
    }
    expect(await context(ISSUED + 1470)).toBeNull();
    // Slow-clock edge: at real 08:25, the runtime is 30s behind, at E.
    expect(await context(ISSUED + 1500 - 30)).toBeNull();
    expect(await context(ISSUED + 1600)).toBeNull();
  });

  it("refuses old run/attempt/head credentials and public verifier material", async () => {
    const active = (await context())!;
    for (const presented of [
      verifier.credentialSha256,
      q,
      raw,
      `qa1.${q}.${nonce.slice(0, -1)}B`,
      `${credential}=`,
      ` ${credential}`,
      "x".repeat(513),
      `qa1.${q}.${Buffer.alloc(32, 8).toString("base64url")}`,
    ])
      expect(await qaRunCredentialMatches(active, presented)).toBe(false);
    for (const index of [4, 7, 8]) {
      const changed = [...descriptor];
      changed[index] = index === 4 ? "d".repeat(40) : "2";
      const binding = JSON.stringify({
        ...verifier,
        descriptor: changed,
        q: sha(JSON.stringify(changed)),
      });
      expect(await qaRunCredentialMatches((await context(ISSUED, binding))!, credential)).toBe(
        false,
      );
    }
  });

  it("reserves distinct canonical credential, session and status namespaces", () => {
    const session = `q1s.${q}.${nonce}`;
    const status = `q1p.${q}.${"a".repeat(64)}`;
    expect(qaRunNamespaceMatches(credential, "credential", q)).toBe(true);
    expect(qaRunNamespaceMatches(session, "session", q)).toBe(true);
    expect(qaRunNamespaceMatches(status, "status", q)).toBe(true);
    expect(qaRunNamespaceMatches(session, "credential", q)).toBe(false);
    expect(qaRunNamespaceMatches(credential, "session", q)).toBe(false);
    expect(qaRunNamespaceMatches(status, "status", "f".repeat(64))).toBe(false);
    expect(qaRunNamespaceMatches(`${status}x`, "status", q)).toBe(false);
    expect(qaRunNamespaceMatches(`q1s.${q}.${nonce.slice(1)}`, "session", q)).toBe(false);
  });

  it("clamps small clock reversals and permanently refuses steps over one second", () => {
    let millis = ISSUED * 1000;
    const clock = createQaRunClock(() => millis);
    expect(clock()).toBe(ISSUED);
    millis -= 1000;
    expect(clock()).toBe(ISSUED);
    millis -= 1;
    expect(clock()).toBeNull();
    millis += 10000;
    expect(clock()).toBeNull();
  });

  it.each([NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "poisons invalid clock %s",
    (time) => {
      let millis = time;
      const clock = createQaRunClock(() => millis);
      expect(clock()).toBeNull();
      millis = ISSUED * 1000;
      expect(clock()).toBeNull();
    },
  );
});
