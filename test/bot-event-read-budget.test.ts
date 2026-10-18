import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressEffects } from "../src/agent-events/service";
import { observeDiscordEvent, signedEventReader } from "../src/bot/event-read";
import { sha256Hex } from "../src/bot/signer";
import { clearAuditRows } from "./helpers/audit-rows";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Acceptance contract for the signed event.read transport: the reader must
// settle inside its existing 2.5-second observation budget and refuse
// oversized bodies before parsing, even when the injected transport ignores
// the abort signal or its cleanup never settles. The byte ceiling is the
// existing 256 KiB provider-buffer convention (src/discord-http.ts).
const BUDGET_MS = 2_500;
const MAX_BYTES = 262_144;
const MARKER = "provider-body-marker-must-not-leak";

const cfg = {
  baseUrl: "https://bot.fixture.test",
  keyId: "fixture-key",
  secret: "fixture-secret-not-a-credential",
};
const local = { event_key: "01FIXTURE000000000000000000", discord_event_id: "1545644954272137000" };
const observation = {
  event_id: local.discord_event_id,
  name: "Café fixture observation",
  starts_at: "2030-07-01T19:00:00Z",
  location: "Voice",
  status: "scheduled",
  observed_at: "2030-07-01T18:00:00Z",
};
const unreachable = { unavailable: "verification_unavailable", reason: "bot_unreachable" };

const encoder = new TextEncoder();
const jsonBytes = (body: unknown) => encoder.encode(JSON.stringify(body));

// A valid success document whose encoded JSON is exactly `totalBytes` long:
// the padding rides in `name`, a field the reader returns verbatim, so an
// under-ceiling document must round-trip and an over-ceiling one proves the
// cap is applied before parsing (it would otherwise parse successfully).
function paddedDoc(totalBytes: number) {
  const base = { ok: true, result: { ...observation, name: "" } };
  const pad = totalBytes - jsonBytes(base).byteLength;
  if (pad < 0) throw new Error("fixture document already exceeds the requested size");
  const name = "x".repeat(pad);
  const doc = { ok: true, result: { ...observation, name } };
  if (jsonBytes(doc).byteLength !== totalBytes) throw new Error("fixture size miscalculated");
  return { doc, name };
}

function outcome<T>(promise: Promise<T>) {
  let result: { value: T } | { error: unknown } | undefined;
  void promise.then(
    (value) => {
      result = { value };
    },
    (error) => {
      result = { error };
    },
  );
  return () => result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CancelHook = () => void | Promise<void>;

function streamBody(
  chunks: Uint8Array[],
  { close = true, cancel = vi.fn<CancelHook>() }: { close?: boolean; cancel?: unknown } = {},
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of chunks) c.enqueue(chunk);
      if (close) c.close();
    },
    cancel: cancel as CancelHook,
  });
  return { body, cancel: cancel as ReturnType<typeof vi.fn>, controller: () => controller };
}

function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

const observe = (fetcher: typeof fetch) =>
  observeDiscordEvent(local, signedEventReader(cfg, fetcher));

// Signing the request is real async crypto: under fake timers a bare
// advanceTimersByTimeAsync(BUDGET) can fire before the fetcher is ever
// invoked, and zero-millisecond advances do not give the crypto work
// wall-clock time. Wait (real time, zero fake milliseconds) until the
// single attempt is on the wire, so the budget advances below measure
// transport time only.
async function untilFetcherCalled(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  // Zero-fake-ms poll: advanceTimersByTimeAsync(0) flushes microtasks/real
  // crypto without advancing the fake clock, so the 2,500 ms budget measured
  // below covers transport time only.
  for (let i = 0; i < 500 && fetcher.mock.calls.length === 0; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(fetcher.mock.calls.length).toBe(1);
}

// Wait (real time, zero fake milliseconds) for microtask-driven settlement;
// on timeout the caller's own assertion reports the unsettled state.
async function flushUntil(condition: () => boolean) {
  await vi
    .waitFor(() => expect(condition()).toBe(true), { timeout: 2_000, interval: 1 })
    .catch(() => {});
}

// Yield a few event-loop turns under the fake clock so late handlers and
// unhandled-rejection checkpoints can run, without consuming fake budget.
async function flushRounds(rounds = 5) {
  for (let round = 0; round < rounds; round++) await vi.advanceTimersByTimeAsync(0);
}

// Every fetcher is a local stub, never the staging bot or a live guild.
describe("signed bot event.read budget and byte ceiling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("positive controls: existing behaviour is unchanged", () => {
    it("returns a valid chunked observation under the ceiling byte-for-byte", async () => {
      const bytes = jsonBytes({ ok: true, result: observation });
      // Split inside the two-byte "é" so only true byte buffering survives.
      const split = bytes.indexOf(0xc3) + 1;
      const { body } = streamBody([
        bytes.slice(0, split),
        bytes.slice(split, split + 3),
        bytes.slice(split + 3),
      ]);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      expect(await observe(fetcher)).toEqual(observation);
      expect(fetcher).toHaveBeenCalledOnce();
      const init = fetcher.mock.calls[0]![1]!;
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("accepts a valid response of exactly 256 KiB", async () => {
      const { doc, name } = paddedDoc(MAX_BYTES);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(doc), { status: 200 }));
      expect(await observe(fetcher)).toEqual({ ...observation, name });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps mirror-ID mismatch behaviour for a chunked reply", async () => {
      const bytes = jsonBytes({ ok: true, result: { ...observation, event_id: "other" } });
      const { body } = streamBody([bytes.slice(0, 10), bytes.slice(10)]);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      expect(await observe(fetcher)).toEqual({
        unavailable: "verification_unavailable",
        reason: "mirror_mismatch",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("keeps the typed bot error code and never leaks the provider body", async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "action_not_allowed", message: MARKER },
            extra: MARKER,
          }),
          { status: 403 },
        ),
      );
      const answer = await observe(fetcher);
      expect(answer).toEqual({
        unavailable: "verification_unavailable",
        reason: "action_not_allowed",
      });
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("malformed JSON is bot_unreachable without leaking body text", async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(`not json ${MARKER}`, { status: 200 }));
      const answer = await observe(fetcher);
      expect(answer).toEqual(unreachable);
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe("owned deadline settlement", () => {
    it("settles a never-resolving fetch that ignores the abort signal at the budget", async () => {
      let signal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof fetch>((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      const result = outcome(observe(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
      expect(result()).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(result()).toEqual({ value: unreachable });
      expect(signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("settles a transport that honours the abort signal by the same budget", async () => {
      const fetcher = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("fixture abort")), {
              once: true,
            });
          }),
      );
      const result = outcome(observe(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      expect(result()).toEqual({ value: unreachable });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a body that stalls after headers and settles at the budget", async () => {
      const { body, cancel } = streamBody([], { close: false });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      const result = outcome(observe(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
      expect(result()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not reset the deadline at headers or after partial body progress", async () => {
      const gate = deferred<Response>();
      const { body, cancel, controller } = streamBody([], { close: false });
      const fetcher = vi.fn<typeof fetch>(() => gate.promise);
      const result = outcome(observe(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS - 100);
      gate.resolve(new Response(body, { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      controller().enqueue(encoder.encode("{"));
      await vi.advanceTimersByTimeAsync(99);
      expect(result()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("settles even when body cancellation itself never resolves", async () => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const { body } = streamBody([], { close: false, cancel });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      const result = outcome(observe(fetcher));
      await untilFetcherCalled(fetcher);
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["rejects", () => Promise.reject(new Error("fixture cancel rejection"))],
      [
        "throws",
        () => {
          throw new Error("fixture cancel throw");
        },
      ],
    ])("settles without an unhandled rejection when cancellation %s", async (_name, hook) => {
      const unhandled = trackUnhandledRejections();
      try {
        const cancel = vi.fn(hook);
        const { body } = streamBody([], { close: false, cancel });
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(body, { status: 200 }));
        const result = outcome(observe(fetcher));
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS);
        expect(result()).toEqual({ value: unreachable });
        expect(cancel).toHaveBeenCalledOnce();
        await flushRounds();
        expect(unhandled.seen).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unhandled.stop();
      }
    });

    it("cancels headers that arrive after the deadline and keeps the settled answer", async () => {
      const unhandled = trackUnhandledRejections();
      try {
        const gate = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => gate.promise);
        const result = outcome(observe(fetcher));
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS);
        expect(result()).toEqual({ value: unreachable });
        const { body, cancel } = streamBody([jsonBytes({ ok: true, result: observation })], {
          close: false,
        });
        gate.resolve(new Response(body, { status: 200 }));
        await flushUntil(() => cancel.mock.calls.length > 0);
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(result()).toEqual({ value: unreachable });
        expect(unhandled.seen).toEqual([]);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unhandled.stop();
      }
    });

    it("a late transport rejection cannot change the settled answer or escape unhandled", async () => {
      const unhandled = trackUnhandledRejections();
      try {
        const gate = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => gate.promise);
        const result = outcome(observe(fetcher));
        await untilFetcherCalled(fetcher);
        await vi.advanceTimersByTimeAsync(BUDGET_MS);
        expect(result()).toEqual({ value: unreachable });
        gate.reject(new Error(`late transport failure ${MARKER}`));
        await flushRounds();
        expect(result()).toEqual({ value: unreachable });
        expect(JSON.stringify(result())).not.toContain(MARKER);
        expect(unhandled.seen).toEqual([]);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unhandled.stop();
      }
    });
  });

  describe("response-byte ceiling before parsing", () => {
    it("refuses a valid JSON body one byte over the ceiling", async () => {
      const { doc } = paddedDoc(MAX_BYTES + 1);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(doc), { status: 200 }));
      expect(await observe(fetcher)).toEqual(unreachable);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refuses chunked JSON whose chunks cross the ceiling cumulatively", async () => {
      const { doc } = paddedDoc(MAX_BYTES + 1);
      const bytes = jsonBytes(doc);
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < bytes.byteLength; at += 65_536)
        chunks.push(bytes.slice(at, at + 65_536));
      const { body } = streamBody(chunks);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      expect(await observe(fetcher)).toEqual(unreachable);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("trips the ceiling mid-stream without waiting for close or the deadline", async () => {
      const { doc } = paddedDoc(MAX_BYTES + 1);
      const bytes = jsonBytes(doc);
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < bytes.byteLength; at += 65_536)
        chunks.push(bytes.slice(at, at + 65_536));
      // Leave the stream open: settlement here can only come from the byte
      // ceiling, never from end-of-body or the 2.5-second deadline.
      const { body, cancel } = streamBody(chunks, { close: false });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      const result = outcome(observe(fetcher));
      await untilFetcherCalled(fetcher);
      await flushUntil(() => result() !== undefined);
      expect(result()).toEqual({ value: unreachable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never leaks an oversized provider body into the answer", async () => {
      const { doc } = paddedDoc(MAX_BYTES + 1);
      const poisoned = {
        ...doc,
        result: { ...doc.result, name: `${MARKER}${doc.result.name.slice(MARKER.length)}` },
      };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(poisoned), { status: 200 }));
      const answer = await observe(fetcher);
      expect(answer).toEqual(unreachable);
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });
});

// The observation runs inside the ingress transaction, so a transport that
// never settles would hold the grant/event locks with it. This proof uses
// real timers against the guarded disposable test database only, with a
// bounded wait so the suite itself can never hang on the defect.
describe.skipIf(!process.env.DATABASE_URL)(
  "ingress read releases its locks after a failed observation (agent-testdb)",
  () => {
    const CALLER = "event-read-budget-fixture";
    const ingressCfg = {
      ...DEFAULT_CONFIG,
      enabled: true,
      callerAgentId: CALLER,
      lockWaitMs: 1500,
    };
    const fields = {
      title: "Agent read budget proof",
      game: "Chess",
      description: "Shared public event",
      starts_at: "2099-07-01 20:00",
      ends_at: "2099-07-01 22:00",
      timezone: "Europe/London",
      location: "Voice",
      capacity: 2,
    };
    let fixture: MemberDataFixture;
    let credential: string;

    const call = (op: string, rest: Record<string, unknown> = {}, deps: IngressEffects = {}) =>
      handleAgentEvent(
        fixture.client,
        ingressCfg,
        { op, idempotency_key: randomUUID(), ...rest },
        credential,
        null,
        deps,
      );

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.client`DELETE FROM agent_event_idempotency_keys`;
      await clearAuditRows(fixture.client, ["agent_event_audits"]);
      await fixture.client`DELETE FROM agent_event_hits`;
      await fixture.client`DELETE FROM agent_event_grants`;
      credential = `fixture-${randomUUID()}`;
      await fixture.client`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES (${CALLER}, 'fixture-company', ${ingressCfg.stagingGuildId}, ${await sha256Hex(credential)})`;
    });

    it("returns verification_unavailable and frees the event lock when the bot read never settles", async () => {
      const created = await call("create", { fields });
      expect(created.status).toBe(201);
      const event_key = created.body.event_key as string;
      await fixture.client`UPDATE events SET discord_event_id = 'mapped-id' WHERE event_key = ${event_key}`;

      const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
      const deps: IngressEffects = { readEvent: signedEventReader(cfg, fetcher) };
      const pending = call("read", { event_key }, deps);
      // If the run ends on the defect, fixture disposal kills the pool; keep
      // that late rejection from surfacing as an unhandled rejection.
      void pending.catch(() => {});
      const result = outcome(pending);
      const deadline = Date.now() + 8_000;
      while (result() === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(result()).toEqual({
        value: expect.objectContaining({
          status: 200,
          body: expect.objectContaining({ discord: unreachable }),
        }),
      });
      expect(fetcher).toHaveBeenCalledOnce();

      // A separate transaction must now take both the event row lock and the
      // grant advisory lock immediately: the failed observation released them.
      const [grant] =
        await fixture.client`SELECT id FROM agent_event_grants WHERE agent_id = ${CALLER}`;
      await fixture.client.begin(async (tx) => {
        await tx`SELECT id FROM events WHERE event_key = ${event_key} FOR UPDATE NOWAIT`;
        const [probe] =
          await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${`agent-event-grant:${grant!.id}`}, 0)) AS acquired`;
        expect(probe!.acquired).toBe(true);
      });

      // Ownership checks still refuse before any bot contact.
      await fixture.client`INSERT INTO events (event_key, title, starts_at, ends_at) VALUES ('human-event', 'Human', now(), now())`;
      expect((await call("read", { event_key: "human-event" }, deps)).body.reason).toBe(
        "foreign_event",
      );
      expect(fetcher).toHaveBeenCalledOnce();
    });
  },
);
