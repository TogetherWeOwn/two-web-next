const POLL_INTERVAL = 10_000;
const RESPONSE_DEADLINE = 5_000;
const MAX_RETRY = 30_000;
// Conservative fixture lease until the hub defines an upstream health signal.
const LIVE_LEASE = 30_000;

type Timer = ReturnType<typeof setTimeout>;

export type TopicFrame<T> =
  | { kind: "snapshot" | "patch"; seq: number; value: T }
  | { kind: "unavailable" };

type TopicState<T> = { value: T | null; source: "ssr" | "live" | "poll" | "stale" };
type Socket = EventTarget & { close(): void; send(data: string): void };

interface TopicTransport<T> {
  open(): Socket;
  // Throw on invalid frames; only validated, viewer-projected data reaches the store.
  decode(data: unknown): TopicFrame<T>;
  resync(socket: Socket): void;
  poll?(signal: AbortSignal): Promise<T | null>;
}

/** A per-view Svelte readable. Subscribe during SSR; start it from onMount.
 *  Source describes the transport, not the age of Discord's underlying data.
 */
export function createLiveTopic<T>(initial: T | null, transport: TopicTransport<T>) {
  let state: TopicState<T> = { value: initial, source: "ssr" };
  const subscribers = new Set<(state: TopicState<T>) => void>();
  let mounted = false;

  function publish(value: T | null, source: TopicState<T>["source"]) {
    if (state.value === value && state.source === source) return;
    state = { value, source };
    for (const subscriber of subscribers) subscriber(state);
  }

  function start() {
    if (mounted) throw new Error("Live topic already started");
    mounted = true;
    let stopped = false;
    let socket: Socket | undefined;
    let retry: Timer | undefined;
    let frameDeadline: Timer | undefined;
    let pollTick: Timer | undefined;
    let pollDeadline: Timer | undefined;
    let pollRequest: AbortController | undefined;
    let retryDelay = 1_000;

    function stopPolling() {
      clearTimeout(pollTick);
      clearTimeout(pollDeadline);
      pollTick = undefined;
      const pending = pollRequest;
      pollRequest = undefined;
      pending?.abort();
    }

    function poll(read: NonNullable<TopicTransport<T>["poll"]>) {
      pollTick = setTimeout(() => poll(read), POLL_INTERVAL);
      const request = new AbortController();
      pollRequest = request;
      function finish(value: T | null) {
        if (pollRequest !== request) return;
        pollRequest = undefined;
        clearTimeout(pollDeadline);
        request.abort();
        publish(value, value === null ? "stale" : "poll");
      }
      pollDeadline = setTimeout(() => finish(null), RESPONSE_DEADLINE);
      void Promise.resolve()
        .then(() => (request.signal.aborted ? null : read(request.signal)))
        .then(finish, () => finish(null));
    }

    function disconnect() {
      clearTimeout(frameDeadline);
      const previous = socket;
      socket = undefined;
      previous?.close();
    }

    function fallback() {
      if (pollTick !== undefined) return;
      // Without continuity we can no longer confirm room access or consent.
      // Drop that projection; the same-origin poll must authorize its own.
      publish(null, "stale");
      if (!stopped && transport.poll) poll(transport.poll);
    }

    function recover() {
      disconnect();
      fallback();
      if (stopped) return;
      retry = setTimeout(connect, retryDelay * (0.8 + Math.random() * 0.2));
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
    }

    function connect() {
      let connection: Socket;
      try {
        connection = transport.open();
      } catch {
        recover();
        return;
      }
      socket = connection;
      let seq = 0;
      let gap: number | undefined;
      let expiresAt = 0;

      function lost() {
        if (socket === connection) recover();
      }
      function arm(ms: number) {
        clearTimeout(frameDeadline);
        expiresAt = performance.now() + ms;
        frameDeadline = setTimeout(lost, ms);
      }
      arm(RESPONSE_DEADLINE);
      for (const event of ["close", "error"]) connection.addEventListener(event, lost);
      connection.addEventListener("message", (event) => {
        if (socket !== connection || !(event instanceof MessageEvent)) return;
        // A queued frame must not renew an already expired lease after suspension.
        if (performance.now() >= expiresAt) return lost();
        let frame: TopicFrame<T> | null;
        try {
          frame = transport.decode(event.data);
          if (frame.kind === "unavailable") {
            // Invalidate even a fallback request started before this notice.
            stopPolling();
            return lost();
          }
          if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) return lost();
          if (frame.seq <= seq) return;
          if (frame.kind === "snapshot") {
            if (gap === undefined ? seq !== 0 || frame.seq !== 1 : frame.seq < gap) return;
            gap = undefined;
            stopPolling();
            retryDelay = 1_000;
          } else if (gap !== undefined) {
            return;
          } else if (seq === 0 || frame.seq !== seq + 1) {
            gap = frame.seq;
            fallback();
            if (stopped) return;
            arm(RESPONSE_DEADLINE);
            transport.resync(connection);
            return;
          }
        } catch {
          lost();
          return;
        }
        seq = frame.seq;
        arm(LIVE_LEASE);
        publish(frame.value, "live");
      });
    }

    connect();
    return () => {
      if (stopped) return;
      stopped = true;
      disconnect();
      stopPolling();
      clearTimeout(retry);
      mounted = false;
      publish(null, "stale");
    };
  }

  return {
    start,
    subscribe(subscriber: (state: TopicState<T>) => void) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },
  };
}
