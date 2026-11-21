import { z } from "zod";
import { hasUrlUserinfo } from "../image-policy";
import type { EventReadConfig } from "./event-read";
import { INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

const BODY = '{"action":"voice.snapshot"}';
const MAX_BYTES = 256 * 1024;
const snowflake = z.string().regex(/^\d{1,20}$/);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((s) => [...s].length <= max);
const room = z.object({
  channel_id: snowflake,
  name: text(100),
  position: z.int32().nullable(),
  user_limit: z.uint32(),
  member_ids: z.array(snowflake).max(500),
  afk: z.boolean().optional(),
  occupied_since: z.iso.datetime().nullable().optional(),
  event_key: text(64).optional(),
});
const shape = z.object({
  v: z.literal(1),
  observed_at: z.iso.datetime({ precision: 0 }),
  total_in_voice: z.int().min(0).max(500),
  rooms: z.array(room).max(100),
});
const snapshot = shape.refine(({ rooms, total_in_voice }) => {
  const members = rooms.flatMap((r) => r.member_ids);
  const count = rooms.filter((r) => !r.afk).reduce((n, r) => n + r.member_ids.length, 0);
  return (
    members.length <= 500 &&
    new Set(members).size === members.length &&
    new Set(rooms.map((r) => r.channel_id)).size === rooms.length &&
    count === total_in_voice
  );
});
const success = z.object({ ok: z.literal(true), result: snapshot });
const refusal = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });
export type VoiceSnapshot = z.infer<typeof shape>;
export type VoiceReader = () => Promise<VoiceSnapshot | null>;

function cancel(body?: { cancel(): Promise<void> } | null): void {
  // An abort-ignoring source may never settle cancellation either.
  void body?.cancel().catch(() => undefined);
}

/** Server only: one signed attempt; callers never receive provider errors or text. */
export function signedVoiceReader(cfg: EventReadConfig, send = fetch): VoiceReader {
  return async () => {
    const { baseUrl, keyId, secret } = cfg;
    if (!baseUrl) return null;
    if (!keyId || !secret) {
      console.warn("voice.snapshot signing credentials missing");
      return null;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 2_500);
    });
    const operation = async () => {
      const url = new URL(INTERNAL_ACTIONS_PATH, baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || hasUrlUserinfo(baseUrl))
        return null;
      let headers: Awaited<ReturnType<typeof signInternalAction>>;
      try {
        const stamp = Math.floor(Date.now() / 1_000);
        headers = await signInternalAction(keyId, secret, BODY, stamp, newNonce());
      } catch {
        if (!signal.aborted) console.warn("voice.snapshot local signing failed");
        return null;
      }
      if (signal.aborted) return null;
      const response = await send(url.toString(), {
        method: "POST",
        body: BODY,
        redirect: "manual",
        signal,
        headers: { ...headers, "Content-Type": "application/json" },
      });
      const redirect = response.status >= 300 && response.status < 400;
      if (signal.aborted || response.redirected || redirect) {
        cancel(response.body);
        return null;
      }
      stream = response.body?.getReader();
      if (!stream) return null;
      const bytes = new Uint8Array(MAX_BYTES);
      let size = 0;
      for (;;) {
        const { done, value } = await stream.read();
        if (signal.aborted) return null;
        if (done) break;
        if (size + value.byteLength > MAX_BYTES) return null;
        bytes.set(value, size);
        size += value.byteLength;
      }
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      const doc: unknown = JSON.parse(decoder.decode(bytes.subarray(0, size)));
      if (response.ok) return success.safeParse(doc).data?.result ?? null;
      const code = refusal.safeParse(doc).data?.error.code;
      if (code === "unauthorized" || code === "stale_request")
        console.warn("voice.snapshot signing refused");
      return null;
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      controller.abort();
      cancel(stream);
      stream?.releaseLock();
    }
  };
}
