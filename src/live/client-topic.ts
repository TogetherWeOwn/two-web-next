const POLL_INTERVAL = 10_000;
const RESPONSE_DEADLINE = 5_000;
const MAX_RETRY = 30_000;

type Timer = ReturnType<typeof setTimeout>;

export type TopicFrame<T, P> =
  | { kind: "snapshot"; seq: number; value: T }
  | { kind: "patch"; seq: number; patch: P }
  | { kind: "resync" };

type TopicState<T> = { value: T | null; source: "ssr" | "live" | "poll" | "stale" };
type Socket = EventTarget & { close(): void };

interface TopicTransport<T, P> {
  open(): Socket;
  // Decode only validated, viewer-projected data. Ignore control frames with
  // null; throw for a malformed data frame so we don't apply its successors.
  decode(data: unknown): TopicFrame<T, P> | null;
  patch(value: T, patch: P): T;
  poll(signal: AbortSignal): Promise<T | null>;
}

/** A per-view Svelte readable. Subscribe during SSR; start it from onMount.
 *  Source describes the transport, not the age of Discord's underlying data.
 */
export function createLiveTopic<T, P>(initial: T | null, transport: TopicTransport<T, P>) {
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
    let firstFrame: Timer | undefined;
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

    function poll() {
      pollTick = setTimeout(poll, POLL_INTERVAL);
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
        .then(() => (request.signal.aborted ? null : transport.poll(request.signal)))
        .then(finish, () => finish(null));
    }

    function disconnect() {
      clearTimeout(firstFrame);
      const previous = socket;
      socket = undefined;
      previous?.close();
    }

    function recover() {
      disconnect();
      if (pollTick === undefined) {
        // A disconnected stream can no longer confirm room access or consent.
        // Drop that projection; the same-origin poll must authorize its own.
        publish(null, "stale");
        if (stopped) return;
        poll();
      }
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
      let current: { seq: number; value: T } | undefined;

      function lost() {
        if (socket === connection) recover();
      }
      firstFrame = setTimeout(lost, RESPONSE_DEADLINE);
      connection.addEventListener("close", lost);
      connection.addEventListener("error", lost);
      connection.addEventListener("message", (event) => {
        if (socket !== connection || !(event instanceof MessageEvent)) return;
        try {
          const frame = transport.decode(event.data);
          if (!frame) return;
          if (frame.kind === "resync" || !Number.isSafeInteger(frame.seq) || frame.seq < 0) {
            lost();
            return;
          }
          if (current && frame.seq < current.seq) return;
          if (frame.kind === "snapshot") {
            stopPolling();
            clearTimeout(firstFrame);
            retryDelay = 1_000;
            current = frame;
          } else {
            if (frame.seq === current?.seq) return;
            if (!current || frame.seq !== current.seq + 1) {
              // The next connection starts with a fresh authoritative snapshot.
              lost();
              return;
            }
            current = { seq: frame.seq, value: transport.patch(current.value, frame.patch) };
          }
        } catch {
          lost();
          return;
        }
        publish(current.value, "live");
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
