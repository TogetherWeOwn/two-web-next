// Acceptance contract: a rejected observation-state write must not strand
// an unreturned pending alert or consume future alert eligibility in the
// same AlertAggregator instance.
//
// Both observation paths in the Durable Object mutate their in-memory
// tracker and only then await storage.put ("/observe" for the spike
// tracker, "/health" for the health tracker). If that put rejects after a
// successful load, no alert is returned to the caller, so the mutation
// must not become visible to later observations on the same instance: a
// retained pending marker would suppress a recovered observation until
// the marker ages out, and retained counts would diverge from the
// persisted snapshot a fresh instance restores. The caller treats a
// thrown or non-ok aggregator response as "fall back to local counting",
// so a rejected write must surface as a failure (never as an ok response,
// and never as a returned alert), and the rejected batch must not also
// be counted later by this instance.
//
// The invariant pinned below, in behavioral terms only: after a rejected
// observation write, the same instance answers later observations exactly
// as a fresh instance over the persisted store would. Any coherent
// publication/rollback strategy satisfies this; replacing a concurrent
// successful update with a stale rollback does not.
//
// These tests drive the real AlertAggregator over scriptable cloning
// fake storage (structuredClone on both get and put). No live Durable
// Object, webhook, Worker, or network. Assertions on held operations
// are collected before gates are released, so a failing run reports
// instead of hanging.
import { describe, expect, it } from "vitest";
import {
  AlertAggregator,
  HEALTH_COOLDOWN_MS,
  SPIKE_COOLDOWN_MS,
  SPIKE_MIN_ERRORS,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const sha = "0123456789abcdef0123456789abcdef01234567";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Cloning fake DO storage with scriptable put outcomes. Directives are
// consumed in put order: "reject" fails that put without touching the
// store; a deferred holds that put in flight until the test settles it
// (resolving lets the write land, rejecting makes it a late failure).
function fakeState() {
  const store = new Map<string, unknown>();
  type Directive = { kind: "reject" } | { kind: "hold"; gate: Deferred<undefined> };
  const directives: Directive[] = [];
  let putCalls = 0;
  const putWaiters = new Map<number, Deferred<undefined>>();

  const state = {
    storage: {
      get: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      put: async (key: string, value: unknown) => {
        putCalls += 1;
        putWaiters.get(putCalls)?.resolve(undefined);
        const directive = directives.shift();
        if (directive?.kind === "reject") throw new Error("storage put rejected");
        if (directive?.kind === "hold") await directive.gate.promise;
        store.set(key, structuredClone(value));
      },
    },
  };

  return {
    state,
    store,
    rejectNextPut: () => {
      directives.push({ kind: "reject" });
    },
    holdNextPut: () => {
      const gate = deferred<undefined>();
      directives.push({ kind: "hold", gate });
      return gate;
    },
    // Resolves once put number n (1-based, across the whole test) starts.
    putStarted: (n: number) => {
      if (putCalls >= n) return Promise.resolve();
      let waiter = putWaiters.get(n);
      if (!waiter) {
        waiter = deferred<undefined>();
        putWaiters.set(n, waiter);
      }
      return waiter.promise;
    },
    putCount: () => putCalls,
    persisted: (key: string) => (store.has(key) ? structuredClone(store.get(key)) : undefined),
  };
}

function post(aggregator: AlertAggregator, path: string, body: unknown) {
  return aggregator.fetch(
    new Request(`https://aggregator.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// A rejected observation write must surface as a failure the caller can
// fall back from: a thrown error or a non-ok response. An ok response
// (with or without an alert) would be a false success: the caller would
// neither retry locally nor learn the state was never persisted.
async function expectObservationFailure(run: () => Promise<Response>) {
  let response: Response | undefined;
  let threw = false;
  try {
    response = await run();
  } catch {
    threw = true;
  }
  expect(threw || (response !== undefined && !response.ok)).toBe(true);
  if (response?.body) await response.body.cancel();
}

const batch = (errors: number, at: number, requests = errors) => ({
  script: "two-web-next",
  buildSha: sha,
  at,
  requests,
  errors,
  crashes: 0,
});

async function observe(aggregator: AlertAggregator, body: unknown) {
  const response = await post(aggregator, "/observe", body);
  expect(response.ok).toBe(true);
  return (await response.json()) as null | {
    event: string;
    requests: number;
    errors: number;
    attemptId?: string;
    timestamp: string;
  };
}

async function health(aggregator: AlertAggregator, ok: boolean, at: number) {
  const response = await post(aggregator, "/health", { ok, at });
  expect(response.ok).toBe(true);
  return (await response.json()) as null | { downMs: number; attemptId: string | null };
}

async function spikeResult(aggregator: AlertAggregator, delivered: boolean, attemptId?: string) {
  const response = await post(aggregator, "/spike-result", {
    script: "two-web-next",
    delivered,
    ...(attemptId !== undefined ? { attemptId } : {}),
  });
  expect(response.ok).toBe(true);
  await response.body?.cancel();
}

async function healthResult(
  aggregator: AlertAggregator,
  delivered: boolean,
  attemptId?: string | null,
) {
  const response = await post(aggregator, "/health-result", {
    delivered,
    ...(attemptId !== undefined ? { attemptId } : {}),
  });
  expect(response.ok).toBe(true);
  await response.body?.cancel();
}

describe("rejected spike observation writes preserve alert eligibility", () => {
  it("seed below threshold, reject the threshold-crossing put, and the same instance still alerts after recovery", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    // Below-threshold errors are persisted successfully first.
    expect(await observe(aggregator, batch(SPIKE_MIN_ERRORS - 2, t0))).toBeNull();
    const persistedBefore = fake.persisted("scripts");

    fake.rejectNextPut();
    await expectObservationFailure(() => post(aggregator, "/observe", batch(2, t0 + 30_000)));
    // Nothing was published: the persisted snapshot is byte-identical.
    expect(fake.persisted("scripts")).toEqual(persistedBefore);

    // After storage recovers, the SAME instance must admit the qualifying
    // observation without waiting for a stranded pending marker to age
    // out. The rejected batch was never published, so resubmitting it
    // counts it exactly once: the alert reports the seeded errors plus
    // this batch, not the rejected attempt on top.
    const alert = await observe(aggregator, batch(2, t0 + 60_000));
    expect(alert).toMatchObject({
      event: "error.spike",
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
      timestamp: new Date(t0 + 60_000).toISOString(),
    });
    expect(alert?.attemptId).toEqual(expect.any(String));
  });

  it("a rejected below-threshold put does not retain its counts in the same instance", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await observe(aggregator, batch(SPIKE_MIN_ERRORS - 2, t0))).toBeNull();

    fake.rejectNextPut();
    await expectObservationFailure(() => post(aggregator, "/observe", batch(1, t0 + 30_000)));

    // A fresh instance over the persisted store would now be one error
    // short of the gate; the same instance must answer identically. If
    // the rejected count lingered in memory, this batch would cross.
    expect(await observe(aggregator, batch(1, t0 + 60_000))).toBeNull();
    const alert = await observe(aggregator, batch(1, t0 + 90_000));
    expect(alert).toMatchObject({
      event: "error.spike",
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
  });

  it("diagnostic control: a fresh instance over the same store alerts after the rejected crossing", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await observe(aggregator, batch(SPIKE_MIN_ERRORS - 2, t0))).toBeNull();
    fake.rejectNextPut();
    await expectObservationFailure(() => post(aggregator, "/observe", batch(2, t0 + 30_000)));

    // The persisted state is healthy: a restarted instance admits the
    // qualifying batch. Any same-instance suppression after recovery
    // therefore belongs to state retained in memory past the rejected
    // write, not to the stored snapshot or the batch shape.
    const restarted = new AlertAggregator(fake.state as never);
    const alert = await observe(restarted, batch(2, t0 + 60_000));
    expect(alert).toMatchObject({ event: "error.spike", errors: SPIKE_MIN_ERRORS });
  });

  it("a late-rejected concurrent put does not replace a successful newer update", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    // Seed one error short of the gate (put #1).
    expect(await observe(aggregator, batch(SPIKE_MIN_ERRORS - 1, t0))).toBeNull();

    // Observation A (traffic only, no new errors) starts; its put (#2) is
    // held in flight. Observation B, which crosses the threshold, starts
    // while A is held. Two interleavings are legitimate and both must
    // end with B published and A rejected: B may complete and return its
    // alert before A's put rejects late, or the aggregator may serialize
    // B behind A so B runs only after A settles. This test pins the
    // outcome, not the interleaving: it gives B a brief chance to reach
    // its put (#3) while A is held, and only then rejects A.
    const gateA = fake.holdNextPut();
    const aRun: Promise<Response> = post(aggregator, "/observe", batch(0, t0 + 30_000, 1)).then(
      (response) => response,
      () => new Response(null, { status: 599 }),
    );
    await fake.putStarted(2);
    const bRun = post(aggregator, "/observe", batch(1, t0 + 60_000));
    const bReachedPut = await Promise.race([
      fake.putStarted(3).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    let bAlert: Awaited<ReturnType<typeof observe>> = null;
    let bAttemptId: string | undefined;
    const readB = async () => {
      const response = await bRun;
      expect(response.ok).toBe(true);
      bAlert = (await response.json()) as Awaited<ReturnType<typeof observe>>;
      bAttemptId = bAlert?.attemptId;
    };
    if (bReachedPut) await readB();
    gateA.reject(new Error("storage put rejected late"));
    const aResponse = await aRun;
    expect(aResponse.ok).toBe(false);
    await aResponse.body?.cancel();
    if (!bReachedPut) await readB();
    expect(bAlert).toMatchObject({ event: "error.spike", errors: SPIKE_MIN_ERRORS });

    // B's published pending attempt must survive A's late failure: a
    // stale rollback to A's pre-write state would clear it and let the
    // next burst page a duplicate.
    expect(await observe(aggregator, batch(1, t0 + 90_000))).toBeNull();
    // B still settles by its own attempt identity, and a delivered B
    // arms the cooldown exactly as a normal successful admission does.
    await spikeResult(aggregator, true, bAttemptId);
    const afterCooldown = t0 + 60_000 + SPIKE_COOLDOWN_MS + 30_000;
    const again = await observe(aggregator, batch(SPIKE_MIN_ERRORS, afterCooldown));
    expect(again).toMatchObject({ event: "error.spike", errors: SPIKE_MIN_ERRORS });
  });

  it("positive control: successful writes persist counts across instances, suppress duplicates, and cool down only when delivered", async () => {
    const fake = fakeState();
    const first = new AlertAggregator(fake.state as never);
    expect(await observe(first, batch(SPIKE_MIN_ERRORS - 2, t0))).toBeNull();

    const revived = new AlertAggregator(fake.state as never);
    const alert = await observe(revived, batch(2, t0 + 30_000));
    expect(alert).toMatchObject({
      event: "error.spike",
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
    // The admitted attempt suppresses a duplicate while it is pending.
    expect(await observe(revived, batch(1, t0 + 60_000))).toBeNull();

    // A failed delivery does not consume the cooldown: the next burst
    // reattempts under a new attempt identity.
    await spikeResult(revived, false, alert?.attemptId);
    const reattempt = await observe(revived, batch(1, t0 + 90_000));
    expect(reattempt).toMatchObject({ event: "error.spike" });
    expect(reattempt?.attemptId).toEqual(expect.any(String));
    expect(reattempt?.attemptId).not.toBe(alert?.attemptId);

    // Attempt fencing: the first attempt's stale delivered result must
    // not settle the reattempt. Settling the reattempt as failed then
    // still reattempts, which a wrongly armed cooldown would prevent.
    await spikeResult(revived, true, alert?.attemptId);
    await spikeResult(revived, false, reattempt?.attemptId);
    expect(await observe(revived, batch(1, t0 + 120_000))).toMatchObject({
      event: "error.spike",
    });
  });
});

describe("rejected health observation writes preserve alert eligibility", () => {
  it("seed a red window, reject the admission put, and the same instance still pages after recovery", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    // First red run opens (and persists) the down window.
    expect(await health(aggregator, false, t0)).toBeNull();
    const persistedBefore = fake.persisted("health");

    fake.rejectNextPut();
    await expectObservationFailure(() =>
      post(aggregator, "/health", { ok: false, at: t0 + 121_000 }),
    );
    expect(fake.persisted("health")).toEqual(persistedBefore);

    // After recovery the same instance pages immediately, with the down
    // window still measured from the persisted first red run.
    const page = await health(aggregator, false, t0 + 122_000);
    expect(page).toMatchObject({ downMs: 122_000 });
    expect(page?.attemptId).toEqual(expect.any(String));

    // Delivered-only cooldown and fencing still hold for the recovered
    // admission: a failed delivery re-pages, a delivered one cools down.
    await healthResult(aggregator, false, page?.attemptId);
    const reattempt = await health(aggregator, false, t0 + 182_000);
    expect(reattempt).toMatchObject({ downMs: 182_000 });
    await healthResult(aggregator, true, reattempt?.attemptId);
    expect(await health(aggregator, false, t0 + 242_000)).toBeNull();
    const afterCooldown = t0 + 182_000 + HEALTH_COOLDOWN_MS + 1_000;
    expect(await health(aggregator, false, afterCooldown)).toMatchObject({
      downMs: afterCooldown - t0,
    });
  });

  it("a rejected first red observation does not start the down window in the same instance", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);

    fake.rejectNextPut();
    await expectObservationFailure(() => post(aggregator, "/health", { ok: false, at: t0 }));
    expect(fake.persisted("health")).toBeUndefined();

    // The window opens at the first persisted red run, so the page is
    // due strictly over two minutes after t0 + 60s, measured from there.
    expect(await health(aggregator, false, t0 + 60_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 180_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 181_000)).toMatchObject({
      downMs: 121_000,
    });
  });

  it("a rejected healthy observation does not erase the persisted down window or its pending attempt", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    const page = await health(aggregator, false, t0 + 121_000);
    expect(page).toMatchObject({ downMs: 121_000 });
    const persistedBefore = fake.persisted("health");

    // A healthy probe whose write is rejected must leave both the
    // persisted and the effective in-memory state untouched: the outage
    // window and the outstanding attempt survive it.
    fake.rejectNextPut();
    await expectObservationFailure(() =>
      post(aggregator, "/health", { ok: true, at: t0 + 180_000 }),
    );
    expect(fake.persisted("health")).toEqual(persistedBefore);

    // Settling the original attempt as failed re-pages on the next red
    // run, still measured from the original first red observation. Had
    // the rejected healthy write taken effect in memory, the window
    // would restart here and no page would be due.
    await healthResult(aggregator, false, page?.attemptId);
    expect(await health(aggregator, false, t0 + 240_000)).toMatchObject({
      downMs: 240_000,
    });
  });

  it("diagnostic control: a fresh instance over the same store pages after the rejected admission", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    fake.rejectNextPut();
    await expectObservationFailure(() =>
      post(aggregator, "/health", { ok: false, at: t0 + 121_000 }),
    );

    const restarted = new AlertAggregator(fake.state as never);
    expect(await health(restarted, false, t0 + 122_000)).toMatchObject({
      downMs: 122_000,
    });
  });

  it("positive control: successful health writes persist across instances and a healthy run clears the window", async () => {
    const fake = fakeState();
    const first = new AlertAggregator(fake.state as never);
    expect(await health(first, false, t0)).toBeNull();
    expect(await health(first, false, t0 + 120_000)).toBeNull();

    const revived = new AlertAggregator(fake.state as never);
    const page = await health(revived, false, t0 + 121_000);
    expect(page).toMatchObject({ downMs: 121_000 });
    expect(page?.attemptId).toEqual(expect.any(String));
    // No duplicate page while the attempt is pending.
    expect(await health(revived, false, t0 + 181_000)).toBeNull();

    // A healthy run clears the window: a later blip starts over and is
    // not due until it has itself been red for over two minutes.
    expect(await health(revived, true, t0 + 240_000)).toBeNull();
    expect(await health(revived, false, t0 + 300_000)).toBeNull();
    expect(await health(revived, false, t0 + 421_000)).toMatchObject({
      downMs: 121_000,
    });
  });
});
