// Prospective isolated attestor. No CLI, environment lookup, default transport or
// installed workflow caller. Structural admission is NOT authority/authentication.
import { createHash } from "node:crypto";

const ERROR = "Staging attestation refused";
const REPOSITORY = "TogetherWeOwn/two-web-next";
const WORKFLOW = ".github/workflows/ci.yml";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const NUMBER = /^[1-9][0-9]{0,15}$/;
const handles = new WeakMap();
const observations = new WeakMap();

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function record(value, keys) {
  requireEvidence(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(","),
  );
}

function time(value) {
  requireEvidence(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
  );
  const result = Date.parse(value);
  requireEvidence(Number.isFinite(result) && new Date(result).toISOString() === value);
  return result;
}

function parse(raw) {
  requireEvidence(typeof raw === "string" && Buffer.byteLength(raw) <= 16_384);
  return JSON.parse(raw);
}

function resolution(value) {
  record(value, [
    "epoch",
    "from",
    "until",
    "entryCreatedAt",
    "entryUpdatedAt",
    "evidenceHash",
    "writerCoverageHash",
    "auditHash",
    "unresolvedPaths",
    "mutations",
    "entryContinuous",
    "precedenceExclusive",
    "protectedInjection",
  ]);
  requireEvidence(
    matches(HASH, value.epoch) &&
      matches(HASH, value.evidenceHash) &&
      matches(HASH, value.writerCoverageHash) &&
      matches(HASH, value.auditHash) &&
      Array.isArray(value.unresolvedPaths) &&
      value.unresolvedPaths.length === 0 &&
      value.mutations === 0 &&
      value.entryContinuous === true &&
      value.precedenceExclusive === true &&
      value.protectedInjection === true,
  );
  const created = time(value.entryCreatedAt);
  const updated = time(value.entryUpdatedAt);
  requireEvidence(created <= updated && updated <= time(value.from));
  requireEvidence(time(value.from) < time(value.until));
}

// All records must be supplied through an independently admitted protected caller.
// Hashes identify records; they do not authenticate their author or prove R. This
// function cannot turn a JSON file, input, variable or fixture into a use grant.
export function prepareAttestation(envelopeJson, contextJson, now = Date.now()) {
  try {
    const envelope = parse(envelopeJson);
    const context = parse(contextJson);
    record(envelope, ["schema", "invocation", "resolution", "audience"]);
    requireEvidence(envelope.schema === "two.staging-attestor-envelope.v1");
    const pin = envelope.invocation;
    record(pin, [
      "repositoryId",
      "controlSha",
      "ref",
      "runId",
      "runAttempt",
      "job",
      "closureHash",
      "useGrantHash",
      "queuedAt",
      "expiresAt",
    ]);
    requireEvidence(
      matches(NUMBER, pin.repositoryId) &&
        matches(SHA, pin.controlSha) &&
        typeof pin.ref === "string" &&
        /^refs\/heads\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(pin.ref) &&
        pin.ref !== "refs/heads/main" &&
        matches(NUMBER, pin.runId) &&
        pin.runAttempt === "1" &&
        pin.job === "staging-principal-attest" &&
        matches(HASH, pin.closureHash) &&
        matches(HASH, pin.useGrantHash),
    );
    record(context, [
      "repository",
      "repositoryId",
      "event",
      "ref",
      "sha",
      "workflowSha",
      "workflowRef",
      "runId",
      "runAttempt",
      "job",
      "checkoutSha",
    ]);
    requireEvidence(
      context.repository === REPOSITORY &&
        context.repositoryId === pin.repositoryId &&
        context.event === "workflow_dispatch" &&
        context.ref === pin.ref &&
        context.sha === pin.controlSha &&
        context.workflowSha === pin.controlSha &&
        context.checkoutSha === pin.controlSha &&
        context.workflowRef === `${REPOSITORY}/${WORKFLOW}@${pin.ref}` &&
        context.runId === pin.runId &&
        context.runAttempt === pin.runAttempt &&
        context.job === pin.job,
    );
    resolution(envelope.resolution);
    const audience = envelope.audience;
    record(audience, [
      "family",
      "accountId",
      "familyEvidenceHash",
      "readerIdentity",
      "readerGrantHash",
    ]);
    requireEvidence(
      audience.family === "account" &&
        matches(ID, audience.accountId) &&
        matches(HASH, audience.familyEvidenceHash) &&
        matches(ID, audience.readerIdentity) &&
        matches(HASH, audience.readerGrantHash),
    );
    const queued = time(pin.queuedAt);
    const expiry = time(pin.expiresAt);
    requireEvidence(
      Number.isSafeInteger(now) &&
        time(envelope.resolution.from) <= queued &&
        queued <= now &&
        now < expiry &&
        expiry <= time(envelope.resolution.until) &&
        expiry - queued <= 120_000,
    );
    const handle = Object.freeze({
      scope: "structural-preflight-only",
      operationalAdmission: false,
    });
    handles.set(handle, { envelope, started: now, used: false });
    return handle;
  } catch {
    throw new Error(ERROR);
  }
}

function live(state, signal, now) {
  requireEvidence(signal instanceof AbortSignal);
  signal.throwIfAborted();
  const current = now();
  requireEvidence(
    Number.isSafeInteger(current) &&
      current >= state.started &&
      current < time(state.envelope.invocation.expiresAt),
  );
  return current;
}

// Settle even when an injected transport/stream ignores AbortSignal. Attach both
// continuations before checking abort so late rejection cannot be unhandled.
function bounded(promise, signal, discard = null) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted && discard) {
          // A late response still owns a body after the caller was refused.
          // Request bounded cleanup; neither its success nor failure can revive
          // the operation. Both continuations preserve the existing refusal.
          Promise.resolve()
            .then(() => discard(value))
            .then(
              () => reject(signal.reason),
              () => reject(signal.reason),
            );
        } else if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function cancelBody(body, signal) {
  if (body && typeof body.cancel === "function") {
    await bounded(body.cancel(), AbortSignal.any([signal, AbortSignal.timeout(1000)]));
  }
}

async function body(response, state, signal, now) {
  try {
    requireEvidence(
      response.status === 200 &&
        !response.redirected &&
        /^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") &&
        response.body &&
        typeof response.body.getReader === "function",
    );
  } catch {
    await cancelBody(response?.body, signal);
    throw new Error(ERROR);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      live(state, signal, now);
      const part = await bounded(reader.read(), signal);
      live(state, signal, now);
      if (part.done) break;
      requireEvidence(part.value instanceof Uint8Array);
      size += part.value.byteLength;
      requireEvidence(size <= 16_384);
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try {
      await bounded(reader.cancel(), AbortSignal.any([signal, AbortSignal.timeout(1000)]));
    } finally {
      reader.releaseLock();
    }
  }
  live(state, signal, now);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

// One subject-only fixed-audience GET. The transport is mandatory so importing
// this module or executing fixtures never contacts a provider. No policy reader
// credential, fallback, retries, token hash or caller-supplied subject ID exists.
export async function observeAttestationSubject(
  handle,
  { subject, transport, signal, now = Date.now } = {},
) {
  try {
    const state = handles.get(handle);
    requireEvidence(state && !state.used);
    state.used = true; // Even a denial/cancellation consumes this local handle.
    requireEvidence(typeof transport === "function" && typeof now === "function");
    requireEvidence(typeof subject === "string" && /^[A-Za-z0-9_-]{20,256}$/.test(subject));
    requireEvidence(!JSON.stringify(state.envelope).includes(subject));
    const requestStart = live(state, signal, now);
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(10_000),
      AbortSignal.timeout(time(state.envelope.invocation.expiresAt) - requestStart),
    ]);
    live(state, combined, now);
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${state.envelope.audience.accountId}/tokens/verify`;
    const response = await bounded(
      transport(endpoint, {
        method: "GET",
        headers: { authorization: `Bearer ${subject}`, accept: "application/json" },
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: combined,
      }),
      combined,
      (late) => cancelBody(late?.body, combined),
    );
    const raw = await body(response, state, combined, now);
    live(state, combined, now);
    requireEvidence(
      raw && raw.success === true && Array.isArray(raw.errors) && raw.errors.length === 0,
    );
    requireEvidence(
      raw.result &&
        matches(ID, raw.result.id) &&
        !raw.result.id.includes(subject) &&
        raw.result.status === "active",
    );
    // Only these selected nonsecret fields leave the response boundary. No raw
    // response/hash, JWT, headers, capability or token-derived fingerprint.
    const observation = Object.freeze({ id: raw.result.id, status: "active" });
    observations.set(observation, { state, observedAt: live(state, combined, now) });
    return observation;
  } catch {
    throw new Error(ERROR);
  }
}

// Post-use R reconciliation is mandatory. It is still externally authored
// evidence, not immutable secret-version proof or independent R acceptance.
export function finishAttestation(handle, observation, closingJson, now = Date.now()) {
  try {
    const state = handles.get(handle);
    const observed = observations.get(observation);
    requireEvidence(state && observed?.state === state);
    // A genuine pair is terminal even when its closing evidence is rejected.
    // A forged or wrong-handle attempt cannot consume another observation.
    observations.delete(observation);
    requireEvidence(Number.isSafeInteger(now));
    const closing = parse(closingJson);
    resolution(closing);
    const opening = state.envelope.resolution;
    for (const key of [
      "epoch",
      "from",
      "until",
      "entryCreatedAt",
      "entryUpdatedAt",
      "writerCoverageHash",
    ]) {
      requireEvidence(closing[key] === opening[key]);
    }
    requireEvidence(observed.observedAt <= now && now < time(opening.until));
    const pin = state.envelope.invocation;
    return Object.freeze({
      schema: "two.staging-subject-observation.v1",
      scope: "subject-id-and-supplied-resolution-records-only",
      operationalAdmission: false,
      qualification: false,
      promotable: false,
      repository: REPOSITORY,
      repositoryId: pin.repositoryId,
      workflow: WORKFLOW,
      controlSha: pin.controlSha,
      ref: pin.ref,
      runId: pin.runId,
      runAttempt: pin.runAttempt,
      job: pin.job,
      closureHash: pin.closureHash,
      useGrantHash: pin.useGrantHash,
      secretReference: "staging/CLOUDFLARE_API_TOKEN",
      resolutionEpoch: opening.epoch,
      openingEvidenceHash: opening.evidenceHash,
      closingEvidenceHash: closing.evidenceHash,
      closingAuditHash: closing.auditHash,
      accountId: state.envelope.audience.accountId,
      subjectId: observation.id,
      status: observation.status,
      observedAt: new Date(observed.observedAt).toISOString(),
      completedAt: new Date(now).toISOString(),
      requiresIndependentResolutionAcceptance: true,
      requiresSeparateSameIdPolicy: true,
    });
  } catch {
    throw new Error(ERROR);
  }
}

export function attestorSourceHash(bytes) {
  requireEvidence(bytes instanceof Uint8Array && bytes.byteLength <= 200_000);
  return createHash("sha256").update(bytes).digest("hex");
}
