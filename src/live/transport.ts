import { z } from "zod";
import { INTERNAL_ACTIONS_PATH, newNonce, sha256Hex, signInternalAction } from "../bot/signer";
import { exceedsByteLimit } from "../http/length-limit";
import type { LiveSnapshot } from "./sequence";

export const LIVE_INGEST_PATH = "/internal/discord-live/v1/ingest";
const SKEW_SECONDS = 60;
const DEADLINE_MS = 2_500;
const DELTA_BYTES = 64 * 1024;
export const SNAPSHOT_BYTES = 1024 * 1024;
const HMAC = { name: "HMAC", hash: "SHA-256" };
export const utcTimestamp = z.iso.datetime().max(30);
type LiveKey = { keyId: string; secret: string };
class TooLarge extends Error {}

async function bounded<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Live request timed out"));
      controller.abort();
    }, DEADLINE_MS);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBytes(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal) {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const bytes = new Uint8Array(limit);
  let size = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return bytes.buffer.slice(0, size);
      if (exceedsByteLimit(value!.byteLength, limit - size)) throw new TooLarge();
      bytes.set(value!, size);
      size += value!.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!signal.aborted) cancel();
    reader.releaseLock();
  }
}

type Verification = { status: 200; bytes: ArrayBuffer } | { status: 400 | 401 | 413 };

/** Authenticates bytes only. The caller must validate the decoded guild, schema and seq
 * before admitting any state change. Use only the configured ingress-direction key. */
export async function verifyLiveIngress(
  request: Request,
  key: LiveKey,
  now = Date.now(),
): Promise<Verification> {
  const url = new URL(request.url);
  const id = request.headers.get("X-TWO-Key-Id") ?? "";
  const timestamp = request.headers.get("X-TWO-Timestamp") ?? "";
  const nonce = request.headers.get("X-TWO-Nonce") ?? "";
  const mac = /^sha256=([a-f0-9]{64})$/.exec(request.headers.get("X-TWO-Signature") ?? "");
  if (
    request.method !== "POST" ||
    url.protocol !== "https:" ||
    url.href !== `${url.origin}${LIVE_INGEST_PATH}` ||
    !key.secret ||
    id !== key.keyId ||
    !/^[\w.:-]{1,128}$/.test(id) ||
    !mac ||
    !/^[1-9]\d{0,14}$/.test(timestamp) ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SKEW_SECONDS
  )
    return { status: 401 };
  const body = request.body;
  if (!body) return { status: 400 };
  try {
    return await bounded(async (signal): Promise<Verification> => {
      const bytes = await readBytes(body, DELTA_BYTES, signal);
      const utf8 = new TextEncoder();
      const imported = await crypto.subtle.importKey("raw", utf8.encode(key.secret), HMAC, false, [
        "verify",
      ]);
      signal.throwIfAborted();
      const signature = Uint8Array.from(mac[1]!.match(/../g)!, (pair) => Number.parseInt(pair, 16));
      const canonical = `POST\n${LIVE_INGEST_PATH}\n${timestamp}\n${nonce}\n${await sha256Hex(bytes)}`;
      signal.throwIfAborted();
      return (await crypto.subtle.verify(HMAC, imported, signature, utf8.encode(canonical)))
        ? { status: 200, bytes }
        : { status: 401 };
    });
  } catch (error) {
    return { status: error instanceof TooLarge ? 413 : 400 };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One signed pull with a dedicated read credential. The topic decoder must check the entire
 * allowlisted state, including completeness; a rejected reply never supplies a cursor. */
export function signedLiveSnapshot<State>(
  config: LiveKey & { origin: string; guildId: string },
  decodeTopics: (value: Record<string, unknown>) => State | null,
  fetcher: typeof fetch = fetch,
): () => Promise<LiveSnapshot<State> | null> {
  return async () => {
    try {
      const origin = new URL(config.origin);
      if (
        origin.protocol !== "https:" ||
        origin.href !== `${origin.origin}/` ||
        !config.keyId ||
        !config.secret ||
        !/^[1-9]\d{0,19}$/.test(config.guildId)
      )
        return null;
      return await bounded(async (signal) => {
        const body = JSON.stringify({ action: "live.snapshot", guild_id: config.guildId });
        const headers = await signInternalAction(
          config.keyId,
          config.secret,
          body,
          Math.floor(Date.now() / 1000),
          newNonce(),
        );
        signal.throwIfAborted();
        const response = await fetcher(`${origin.origin}${INTERNAL_ACTIONS_PATH}`, {
          method: "POST",
          body,
          signal,
          redirect: "manual",
          headers: { ...headers, "Content-Type": "application/json" },
        });
        if (signal.aborted || response.status !== 200 || response.redirected) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        if (!response.body) return null;
        const bytes = await readBytes(response.body, SNAPSHOT_BYTES, signal);
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const doc: unknown = JSON.parse(decoder.decode(bytes));
        if (
          !record(doc) ||
          Object.keys(doc).length !== 5 ||
          doc.v !== 1 ||
          doc.guild_id !== config.guildId ||
          typeof doc.seq !== "number" ||
          !Number.isSafeInteger(doc.seq) ||
          doc.seq < 0 ||
          !utcTimestamp.safeParse(doc.observed_at).success ||
          !record(doc.topics)
        )
          return null;
        const state = decodeTopics(doc.topics);
        return state === null ? null : { seq: doc.seq, state };
      });
    } catch {
      return null;
    }
  };
}
