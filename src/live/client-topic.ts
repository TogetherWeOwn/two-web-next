const POLL_INTERVAL = 10_000;
const IO_TIMEOUT = 5_000;
const COMMAND_TIMEOUT = 15_000;
const RESYNC_COOLDOWN = 2_000;
const INITIAL_RETRY = 1_000;
const MAX_RETRY = 30_000;

type Timer = ReturnType<typeof setTimeout>;
export type TopicFrame<T> =
  | { kind: "snapshot" | "patch"; seq: number; value: T }
  | { kind: "unavailable" };

type TopicState<T> = { value: T | null; source: "ssr" | "live" | "poll" | "stale" };
interface TopicTransport<T> {
  open(): WebSocket;
  decode(data: unknown): TopicFrame<T>;
  command(socket: WebSocket, type: "subscribe" | "resync"): void;
  poll?(signal: AbortSignal): Promise<T | null>;
}

/** Subscribe during SSR and start from onMount. Poll values may be out of date. */
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
    let socket: WebSocket | undefined;
    let retry: Timer | undefined;
    let socketTimer: Timer | undefined;
    let retryDelay = INITIAL_RETRY;
    let pollTick: Timer | undefined;
    let pollDeadline: Timer | undefined;
    let pollRequest: AbortController | undefined;

    function cancelPoll() {
      clearTimeout(pollDeadline);
      const request = pollRequest;
      pollRequest = undefined;
      request?.abort();
    }

    function stopPolling() {
      clearTimeout(pollTick);
      pollTick = undefined;
      cancelPoll();
    }

    function poll(read: NonNullable<TopicTransport<T>["poll"]>) {
      cancelPoll();
      pollTick = setTimeout(() => poll(read), POLL_INTERVAL);
      const request = new AbortController();
      pollRequest = request;
      function finish(value: T | null) {
        if (pollRequest !== request) return;
        cancelPoll();
        publish(value, value === null ? "stale" : "poll");
      }
      pollDeadline = setTimeout(() => finish(null), IO_TIMEOUT);
      void Promise.resolve()
        .then(() => (request.signal.aborted ? null : read(request.signal)))
        .then(finish, () => finish(null));
    }

    function disconnect() {
      clearTimeout(socketTimer);
      const previous = socket;
      socket = undefined;
      previous?.close();
    }

    function fallback() {
      cancelPoll();
      if (state.source !== "poll") publish(null, "stale");
      if (!stopped && pollTick === undefined && transport.poll) poll(transport.poll);
    }

    function recover() {
      disconnect();
      fallback();
      if (stopped) return;
      retry = setTimeout(connect, retryDelay * (0.8 + Math.random() * 0.2));
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
    }

    function connect() {
      if (stopped) return;
      let connection: WebSocket;
      try {
        connection = transport.open();
      } catch {
        recover();
        return;
      }
      socket = connection;
      let seq = 0;
      let gap = 0;
      let mode: "live" | "gap" | "withdrawn" = "withdrawn";
      let resyncAfter = 0;
      let deadline = performance.now() + IO_TIMEOUT;
      function lost() {
        if (socket === connection) recover();
      }
      function send(type: "subscribe" | "resync") {
        if (socket !== connection) return;
        deadline = performance.now() + COMMAND_TIMEOUT;
        socketTimer = setTimeout(lost, COMMAND_TIMEOUT);
        try {
          transport.command(connection, type);
        } catch {
          lost();
        }
      }
      socketTimer = setTimeout(lost, IO_TIMEOUT);
      connection.addEventListener("open", opened, { once: true });
      for (const event of ["close", "error"] as const) connection.addEventListener(event, lost);
      function opened() {
        if (socket !== connection) return;
        if (performance.now() >= deadline) return lost();
        clearTimeout(socketTimer);
        send("subscribe");
      }

      function withdraw(reason: "gap" | "withdrawn") {
        mode = reason;
        fallback();
        if (socket !== connection || socketTimer !== undefined) return;
        socketTimer = setTimeout(
          () => send("resync"),
          Math.max(0, resyncAfter - performance.now()) + Math.random() * 400,
        );
      }

      connection.addEventListener("message", (event) => {
        if (socket !== connection) return;
        const now = performance.now();
        if (deadline !== 0 && now >= deadline) return lost();
        let frame: TopicFrame<T>;
        try {
          frame = transport.decode(event.data);
        } catch {
          return lost();
        }
        if (frame.kind === "unavailable") return withdraw("withdrawn");
        if (frame.seq <= seq) return;
        if (frame.kind === "snapshot") {
          if (mode === "live" || (seq === 0 ? frame.seq !== 1 : frame.seq < gap)) return;
          clearTimeout(socketTimer);
          socketTimer = undefined;
          deadline = 0;
          gap = 0;
          mode = "live";
          resyncAfter = now + RESYNC_COOLDOWN;
          retryDelay = INITIAL_RETRY;
          stopPolling();
        } else {
          if (mode === "withdrawn") return;
          if (mode === "gap") {
            gap = Math.max(gap, frame.seq);
            return;
          }
          if (frame.seq !== seq + 1) {
            gap = frame.seq;
            return withdraw("gap");
          }
        }
        seq = frame.seq;
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
