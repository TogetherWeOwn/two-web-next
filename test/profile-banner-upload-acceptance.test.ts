// Acceptance contract: member profile banner image upload (spec: profiles epic,
// decision 10 "banners are size-limited, re-encoded and stored in R2").
//
// THIS FILE IS THE SPECIFICATION. The Builder builds on this branch and never
// edits this file (or the fixtures under test/fixtures/banner/). Every
// `acceptance` test below is RED at base (the routes do not exist, so the
// positive steps answer 404) and must turn GREEN with implementation only.
// Tests marked CONTROL pass at base on purpose: they pin fixtures and the
// surrounding contract the Builder must not break.
//
// Pinned contract (binding on the Builder):
// - Routes on the Hono profiles app (profiles stay Hono-served per the epic):
//     POST   /members/:user/banner         multipart field `banner`, owner-only
//     GET    /members/:user/banner?v=<v>   public bytes, version-pinned
//     DELETE /members/:user/banner         owner-only removal
//     POST   /members/:user/banner/hide    moderator-only hide (audit-logged)
//     POST   /members/:user/banner/unhide  moderator-only restore (audit-logged)
// - Accepted bytes: image/jpeg, image/png, image/webp, sniffed (magic bytes
//   must match a listed type), at most BANNER_MAX_BYTES, at most
//   BANNER_MAX_WIDTH x BANNER_MAX_HEIGHT px. Others are rejected with a clear
//   message: oversize is 413 naming "2 MiB"; wrong type or dimensions is 422
//   with `{ errors: { banner } }` naming the accepted types / 2400 x 800.
// - The stored bytes are re-encoded with metadata stripped (no EXIF/GPS
//   survives), kept in the `BANNER_BUCKET` R2 binding under
//   `banners/<userId>/<opaque>`, and served back with
//   `Cache-Control: public, max-age>=31536000, immutable`.
// - Upload answers JSON `{ saved: true, url }` (Accept: JSON) or 303 to
//   /members/:user (HTML form). `url` is same-origin, carries `?v=<version>`,
//   never leaks the R2 key; replacement mints a new key, version and url and
//   deletes the old object; a stale `v` is 404.
// - Moderator hide keeps the object (unhide restores serving) and writes one
//   audit entry per action through the `bannerAudit` deps sink; production
//   wiring persists it to the admin activity log.
// - Uploads are throttle-first (a spent budget beats validation 422s and the
//   owner check, mirroring profile writes): exhausted budget is 429 with
//   Retry-After, zero R2/store writes, on a dedicated `profile-banner:<id>`
//   bucket so uploads never spend the 30/min profile-write budget.
//   Real-store budget: 10 uploads/min/member via checkJoinThrottle.
// - Erasure deletes the banner object: eraseMember's opts gain an optional
//   `banners` bucket; apply mode deletes the member's object, dry-run never
//   does, a missing banner is a silent no-op.
// - Auth mirrors profile writes: guest 401, non-member 403, non-owner 403
//   (a moderator cannot upload to or delete someone else's banner; they hide
//   it instead), unknown user 404. Unsafe methods stay behind the global
//   same-origin guard; GET needs no Origin.
// - Test Author assumptions (flagged, not in the epic): banner BYTES are
//   public and CDN-cacheable like the avatar (the profile-page RENDER may
//   still gate on viewer class in the visibility card); HTML hide/unhide
//   support follows with the moderation UI card and is unspecified here.
//
// Fixtures (test/fixtures/banner/): valid 800x200 JPEG/WebP encoded with
// sharp, valid/over-dimension/over-size PNGs built with node:zlib,
// banner-exif-gps.jpg is the valid JPEG plus a hand-built, parser-valid EXIF
// APP1 (GPS IFD + "GPS-SECRET-LATLON" ImageDescription marker).
// Hermetic except the 10/min budget proof, which is DB-gated to agent-testdb.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { eraseMember, type ErasureSql } from "../src/member-erasure";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { env } from "./helpers/member-data";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(root, "test/fixtures/banner", name)));

const BANNER_MAX_BYTES = 2 * 1024 * 1024;
const BANNER_MAX_WIDTH = 2400;
const BANNER_MAX_HEIGHT = 800;
const GPS_MARKER = "GPS-SECRET-LATLON";

const OWNER = "100000000000000201";
const OTHER = "100000000000000202";
const MODERATOR = "100000000000000203";
const OUTSIDER = "100000000000000204";
const UNKNOWN = "999999999999999999";
const APP_URL = env.APP_URL;

// --- Wished-for seams (intersections: this file typechecks before and after). ---

type BannerRow = {
  key: string;
  contentType: string;
  width: number;
  height: number;
  hidden: boolean;
  version: string;
};

type BannerAuditEntry = {
  action: "banner.hide" | "banner.unhide";
  moderatorId: string;
  subjectId: string;
};

type BannerDeps = ProfileDeps & {
  bannerStore?: {
    get: (id: string) => Promise<BannerRow | null>;
    set: (id: string, row: BannerRow) => Promise<void>;
    clear: (id: string) => Promise<void>;
  };
  bannerAudit?: (entry: BannerAuditEntry) => Promise<void> | void;
};

type BindingsWithBucket = Env & { BANNER_BUCKET: FakeBannerBucket };
type ErasureOptsWithBucket = Parameters<typeof eraseMember>[2] & {
  banners?: FakeBannerBucket;
};

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value && typeof (value as Blob).arrayBuffer === "function")
    return new Uint8Array(await (value as Blob).arrayBuffer());
  if (value && typeof (value as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  throw new Error("fake bucket: unsupported put value");
}

/** Minimal R2Bucket double: put/get/delete/head/list with full call records. */
class FakeBannerBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  puts: { key: string; bytes: Uint8Array; options: unknown }[] = [];
  gets: string[] = [];
  deletes: string[] = [];

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = await toBytes(value);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    this.puts.push({ key, bytes, options });
  }

  async get(key: string) {
    this.gets.push(key);
    const obj = this.objects.get(key);
    if (!obj) return null;
    return {
      key,
      size: obj.bytes.length,
      httpMetadata: obj.contentType ? { contentType: obj.contentType } : {},
      body: obj.bytes,
      arrayBuffer: async () => obj.bytes.slice().buffer as ArrayBuffer,
    };
  }

  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  async head(key: string) {
    const obj = this.objects.get(key);
    return obj ? { key, size: obj.bytes.length } : null;
  }

  async list(options?: { prefix?: string }) {
    const keys = [...this.objects.keys()].filter(
      (key) => !options?.prefix || key.startsWith(options.prefix),
    );
    return { objects: keys.map((key) => ({ key })) };
  }
}

function memoryBannerStore() {
  const rows = new Map<string, BannerRow>();
  const setCalls: { id: string; row: BannerRow }[] = [];
  const clearCalls: string[] = [];
  return {
    rows,
    setCalls,
    clearCalls,
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async set(id: string, row: BannerRow) {
      setCalls.push({ id, row });
      rows.set(id, row);
    },
    async clear(id: string) {
      clearCalls.push(id);
      rows.delete(id);
    },
  };
}

// --- Pure-TS image readers (assert on stored bytes; no native deps). ---

function pngDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint32(8) !== 13) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

function jpegDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = view.getUint16(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { h: view.getUint16(i + 5), w: view.getUint16(i + 7) };
    i += 2 + len;
  }
  return null;
}

function webpDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 16) return null;
  const ascii = (at: number, n: number) => String.fromCharCode(...b.slice(at, at + n));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = ascii(i, 4);
    const size = view.getUint32(i + 4, true);
    const data = i + 8;
    if (fourcc === "VP8 " && data + 10 <= b.length) {
      if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
      const w = view.getUint16(data + 6, true) & 0x3fff;
      const h = view.getUint16(data + 8, true) & 0x3fff;
      return { w, h };
    }
    if (fourcc === "VP8L" && data + 5 <= b.length) {
      if (b[data] !== 0x2f) return null;
      const w = 1 + (((b[data + 2]! & 0x3f) << 8) | b[data + 1]!);
      const h =
        1 + (((b[data + 4]! & 0x0f) << 10) | (b[data + 3]! << 2) | ((b[data + 2]! & 0xc0) >> 6));
      return { w, h };
    }
    i = data + size + (size % 2);
  }
  return null;
}

function dimsFor(contentType: string, bytes: Uint8Array): { w: number; h: number } | null {
  if (contentType === "image/png") return pngDims(bytes);
  if (contentType === "image/jpeg") return jpegDims(bytes);
  if (contentType === "image/webp") return webpDims(bytes);
  return null;
}

const latin1 = (b: Uint8Array): string =>
  Array.from(b.slice(0, Math.min(b.length, 1 << 20)), (c) => String.fromCharCode(c)).join("");

// --- Harness: mounted profiles app behind the real same-origin guard. ---

type Actor = "owner" | "other" | "moderator" | "outsider" | "guest";
const actorId: Record<Exclude<Actor, "guest">, string> = {
  owner: OWNER,
  other: OTHER,
  moderator: MODERATOR,
  outsider: OUTSIDER,
};

async function cookieFor(actor: Actor): Promise<string> {
  if (actor === "guest") return "";
  const store = cookieForStore;
  const id = actorId[actor];
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: id,
    username: actor,
    avatar: null,
    member: actor !== "outsider",
    moderator: actor === "moderator",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
}

// One session store per test, shared by the harness below.
let cookieForStore = createMemorySessionStore();

function memberRow(id: string) {
  return {
    id,
    username: `member-${id.slice(-4)}`,
    avatar: null,
    bio: null,
    games: [],
    timezone: null,
  };
}

function harness(options: { limited?: boolean; retryAfter?: number } = {}) {
  cookieForStore = createMemorySessionStore();
  const sessions = cookieForStore;
  const bucket = new FakeBannerBucket();
  const banners = memoryBannerStore();
  const audits: BannerAuditEntry[] = [];
  const profileSave = vi.fn(async () => {});
  const store = {
    find: vi.fn(async (id: string) =>
      /^\d{10,25}$/.test(id) && id !== UNKNOWN ? memberRow(id) : null,
    ),
    save: profileSave,
  };
  const throttle = vi.fn(async (_bucket: string) =>
    options.limited
      ? ({ limited: true, retryAfter: options.retryAfter ?? 45 } as const)
      : ({ limited: false } as const),
  );
  const deps: BannerDeps = {
    sessionStore: sessions,
    store,
    throttle,
    bannerStore: banners,
    bannerAudit: (entry: BannerAuditEntry) => {
      audits.push(entry);
    },
  };
  const app = new Hono<{ Bindings: BindingsWithBucket }>();
  app.use("*", sameOrigin);
  app.route("/", profilesApp(deps));
  const bindings = { ...env, BANNER_BUCKET: bucket } as BindingsWithBucket;
  return { app, bindings, bucket, banners, audits, store, throttle, profileSave };
}

function uploadRequest(
  userId: string,
  file: { bytes: Uint8Array; filename: string; contentType: string },
  init: { cookie?: string; accept?: string; origin?: string | null } = {},
) {
  const form = new FormData();
  form.append("banner", new Blob([file.bytes], { type: file.contentType }), file.filename);
  const headers: Record<string, string> = { accept: init.accept ?? "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? APP_URL;
  return new Request(`${APP_URL}/members/${userId}/banner`, {
    method: "POST",
    headers,
    body: form,
  });
}

const png = (name = "banner.png") => ({
  bytes: fixture("banner-valid.png"),
  filename: name,
  contentType: "image/png",
});
const jpg = (name = "banner.jpg") => ({
  bytes: fixture("banner-valid.jpg"),
  filename: name,
  contentType: "image/jpeg",
});
const webp = (name = "banner.webp") => ({
  bytes: fixture("banner-valid.webp"),
  filename: name,
  contentType: "image/webp",
});

function expectCacheable(res: Response) {
  const cache = res.headers.get("cache-control") ?? "";
  expect(cache, "cache-control is public").toMatch(/public/);
  expect(cache, "cache-control is immutable").toMatch(/immutable/);
  const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1] ?? "0");
  expect(maxAge, "cache-control max-age is at least a year").toBeGreaterThanOrEqual(31536000);
}

// --- CONTROL: fixtures are what the contract claims (pass at base). ---

describe("CONTROL: banner fixtures", () => {
  it("valid fixtures decode to 800x200 under the size cap", () => {
    expect(pngDims(fixture("banner-valid.png"))).toEqual({ w: 800, h: 200 });
    expect(jpegDims(fixture("banner-valid.jpg"))).toEqual({ w: 800, h: 200 });
    expect(webpDims(fixture("banner-valid.webp"))).toEqual({ w: 800, h: 200 });
    for (const name of ["banner-valid.png", "banner-valid.jpg", "banner-valid.webp"]) {
      expect(fixture(name).length, name).toBeLessThan(BANNER_MAX_BYTES);
    }
  });

  it("dimension-overflow fixtures exceed 2400x800 but stay under the size cap", () => {
    expect(pngDims(fixture("banner-wide.png"))).toEqual({ w: 2401, h: 801 });
    expect(jpegDims(fixture("banner-wide.jpg"))).toEqual({ w: 2401, h: 801 });
    expect(webpDims(fixture("banner-wide.webp"))).toEqual({ w: 2401, h: 801 });
    expect(pngDims(fixture("banner-tall.png"))).toEqual({ w: 800, h: 801 });
    for (const name of [
      "banner-wide.png",
      "banner-wide.jpg",
      "banner-wide.webp",
      "banner-tall.png",
    ]) {
      expect(fixture(name).length, name).toBeLessThan(BANNER_MAX_BYTES);
    }
  });

  it("size-overflow fixture exceeds 2 MiB with in-limit dimensions", () => {
    expect(fixture("banner-huge.png").length).toBeGreaterThan(BANNER_MAX_BYTES);
    expect(pngDims(fixture("banner-huge.png"))).toEqual({ w: 1600, h: 500 });
  });

  it("exif fixture is a decodable JPEG carrying the GPS marker", () => {
    const bytes = fixture("banner-exif-gps.jpg");
    expect(jpegDims(bytes)).toEqual({ w: 800, h: 200 });
    expect(bytes.length).toBeLessThan(BANNER_MAX_BYTES);
    expect(latin1(bytes)).toContain("Exif\0\0");
    expect(latin1(bytes)).toContain(GPS_MARKER);
  });

  it("wrong-type fixtures are a real GIF and plain text", () => {
    const gif = fixture("banner.gif");
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
    expect(new TextDecoder().decode(fixture("banner.txt"))).toContain("not an image");
  });
});

describe("acceptance: banner upload types, size and dimensions", () => {
  it("accepts a PNG banner and serves it back cacheable", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(uploadRequest(OWNER, png(), { cookie }), undefined, h.bindings);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; url: string };
    expect(body.saved).toBe(true);
    expect(body.url.startsWith(`/members/${OWNER}/banner`)).toBe(true);
    expect(body.url).not.toContain("banners/");

    expect(h.bucket.puts).toHaveLength(1);
    const put = h.bucket.puts[0]!;
    expect(put.key).toMatch(new RegExp(`^banners/${OWNER}/[A-Za-z0-9_-]{8,}(\\.[a-z0-9]+)?$`));
    const row = h.banners.rows.get(OWNER);
    expect(row).toMatchObject({
      key: put.key,
      contentType: "image/png",
      width: 800,
      height: 200,
      hidden: false,
    });
    expect(row!.version.length).toBeGreaterThan(0);
    expect(body.url).toContain(`v=${row!.version}`);
    expect(h.profileSave).not.toHaveBeenCalled();

    const served = await h.app.request(
      new URL(body.url, APP_URL).toString(),
      undefined,
      h.bindings,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
    expectCacheable(served);
    const servedBytes = new Uint8Array(await served.arrayBuffer());
    expect(servedBytes).toEqual(put.bytes);
    expect(pngDims(servedBytes)).toEqual({ w: 800, h: 200 });
  });

  it("accepts JPEG and WebP banners with matching served types", async () => {
    for (const file of [jpg(), webp()]) {
      const h = harness();
      const cookie = await cookieFor("owner");
      const res = await h.app.request(
        uploadRequest(OWNER, file, { cookie }),
        undefined,
        h.bindings,
      );
      expect(res.status, file.contentType).toBe(200);
      const body = (await res.json()) as { saved: boolean; url: string };
      const served = await h.app.request(
        new URL(body.url, APP_URL).toString(),
        undefined,
        h.bindings,
      );
      expect(served.status, file.contentType).toBe(200);
      expect(served.headers.get("content-type"), file.contentType).toContain(file.contentType);
      expectCacheable(served);
      const servedBytes = new Uint8Array(await served.arrayBuffer());
      expect(dimsFor(file.contentType, servedBytes), file.contentType).toEqual({ w: 800, h: 200 });
    }
  });

  it("answers an HTML form upload with a 303 to the member page", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(OWNER, png(), { cookie, accept: "text/html" }),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${OWNER}`);
  });

  it.each([
    ["gif", "banner.gif", "image/gif"],
    ["text", "banner.txt", "text/plain"],
    ["octet-stream", "banner.bin", "application/octet-stream"],
  ])("rejects %s with a 422 naming jpeg, png and webp", async (_label, filename, contentType) => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const bytes = filename === "banner.gif" ? fixture("banner.gif") : fixture("banner.txt");
    const res = await h.app.request(
      uploadRequest(OWNER, { bytes, filename, contentType }, { cookie }),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { banner: string } };
    expect(body.errors.banner).toMatch(/jpeg/i);
    expect(body.errors.banner).toMatch(/png/i);
    expect(body.errors.banner).toMatch(/webp/i);
    expect(h.bucket.puts).toHaveLength(0);
    expect(h.banners.setCalls).toHaveLength(0);
    expect(h.profileSave).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not match the declared image type", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(
        OWNER,
        { bytes: fixture("banner.txt"), filename: "fake.png", contentType: "image/png" },
        { cookie },
      ),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { banner: string } };
    expect(body.errors.banner).toMatch(/valid/i);
    expect(h.bucket.puts).toHaveLength(0);
  });

  it("rejects an oversized file with a 413 naming the 2 MiB limit", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(
        OWNER,
        { bytes: fixture("banner-huge.png"), filename: "huge.png", contentType: "image/png" },
        { cookie },
      ),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { reason: string; message: string };
    expect(body.reason).toBe("payload_too_large");
    expect(body.message).toContain(`${BANNER_MAX_BYTES / 1024 / 1024} MiB`);
    expect(h.bucket.puts).toHaveLength(0);
    expect(h.banners.setCalls).toHaveLength(0);
  });

  it.each([
    ["png", "banner-wide.png", "image/png"],
    ["jpeg", "banner-wide.jpg", "image/jpeg"],
    ["webp", "banner-wide.webp", "image/webp"],
  ])("rejects over-wide %s with a 422 naming 2400x800", async (_label, filename, contentType) => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(OWNER, { bytes: fixture(filename), filename, contentType }, { cookie }),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { banner: string } };
    expect(body.errors.banner).toContain(String(BANNER_MAX_WIDTH));
    expect(body.errors.banner).toContain(String(BANNER_MAX_HEIGHT));
    expect(h.bucket.puts).toHaveLength(0);
  });

  it("rejects an over-tall banner with a 422", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(
        OWNER,
        { bytes: fixture("banner-tall.png"), filename: "tall.png", contentType: "image/png" },
        { cookie },
      ),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { banner: string } };
    expect(body.errors.banner).toContain(String(BANNER_MAX_HEIGHT));
    expect(h.bucket.puts).toHaveLength(0);
  });

  it("answers an HTML rejection with a 422 page mentioning the banner", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(
        OWNER,
        { bytes: fixture("banner.gif"), filename: "banner.gif", contentType: "image/gif" },
        { cookie, accept: "text/html" },
      ),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/banner/i);
  });

  it("strips EXIF GPS metadata when re-encoding", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const uploaded = fixture("banner-exif-gps.jpg");
    const res = await h.app.request(
      uploadRequest(
        OWNER,
        { bytes: uploaded, filename: "gps.jpg", contentType: "image/jpeg" },
        { cookie },
      ),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(200);
    expect(h.bucket.puts).toHaveLength(1);
    const stored = h.bucket.puts[0]!.bytes;
    expect(stored).not.toEqual(uploaded);
    expect(latin1(stored)).not.toContain("Exif");
    expect(latin1(stored)).not.toContain(GPS_MARKER);
    expect(stored[0]).toBe(0xff);
    expect(stored[1]).toBe(0xd8);
    expect(stored[stored.length - 2]).toBe(0xff);
    expect(stored[stored.length - 1]).toBe(0xd9);
    expect(jpegDims(stored)).toEqual({ w: 800, h: 200 });

    const body = (await res.json()) as { url: string };
    const served = await h.app.request(
      new URL(body.url, APP_URL).toString(),
      undefined,
      h.bindings,
    );
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(stored);
  });
});

describe("acceptance: banner upload admission", () => {
  it("refuses non-owners with 403, including moderators uploading to others", async () => {
    for (const actor of ["other", "moderator"] as const) {
      const h = harness();
      const cookie = await cookieFor(actor);
      const res = await h.app.request(
        uploadRequest(OWNER, png(), { cookie }),
        undefined,
        h.bindings,
      );
      expect(res.status, actor).toBe(403);
      expect(h.bucket.puts, actor).toHaveLength(0);
    }
  });

  it("answers an unknown user with 404 after a proven-good upload", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const good = await h.app.request(
      uploadRequest(OWNER, png(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(good.status).toBe(200);
    const res = await h.app.request(
      uploadRequest(UNKNOWN, png(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(404);
    expect(h.bucket.puts).toHaveLength(1);
  });

  it("rate-limits on a dedicated banner bucket with 429, Retry-After and zero writes", async () => {
    const h = harness({ limited: true, retryAfter: 45 });
    const cookie = await cookieFor("owner");
    const res = await h.app.request(uploadRequest(OWNER, png(), { cookie }), undefined, h.bindings);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("45");
    const body = (await res.json()) as { reason: string; retry_after: number };
    expect(body.reason).toBe("rate_limited");
    expect(body.retry_after).toBe(45);
    expect(h.throttle).toHaveBeenCalledWith(`profile-banner:${OWNER}`);
    expect(
      h.throttle.mock.calls
        .map((call) => call[0])
        .filter((b) => String(b).startsWith("profile-write:")),
    ).toHaveLength(0);
    expect(h.bucket.puts).toHaveLength(0);
    expect(h.banners.setCalls).toHaveLength(0);
    expect(h.profileSave).not.toHaveBeenCalled();
  });

  it("spends the banner throttle bucket on success, never the profile-write budget", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(uploadRequest(OWNER, png(), { cookie }), undefined, h.bindings);
    expect(res.status).toBe(200);
    expect(h.throttle).toHaveBeenCalledWith(`profile-banner:${OWNER}`);
    expect(
      h.throttle.mock.calls
        .map((call) => call[0])
        .filter((b) => String(b).startsWith("profile-write:")),
    ).toHaveLength(0);
  });

  it("answers a spent budget before validation (429 beats 422)", async () => {
    const h = harness({ limited: true });
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(
        OWNER,
        { bytes: fixture("banner.gif"), filename: "banner.gif", contentType: "image/gif" },
        { cookie },
      ),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(429);
  });

  it("serves banner bytes to guests without requiring Origin", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const uploaded = await h.app.request(
      uploadRequest(OWNER, png(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(uploaded.status).toBe(200);
    const { url } = (await uploaded.json()) as { url: string };
    const forged = new Request(new URL(url, APP_URL).toString(), {
      headers: { origin: "https://evil.example.test" },
    });
    const served = await h.app.request(forged, undefined, h.bindings);
    expect(served.status).toBe(200);
    const anonymous = new Request(new URL(url, APP_URL).toString());
    expect((await h.app.request(anonymous, undefined, h.bindings)).status).toBe(200);
  });
});

describe("acceptance: banner replacement and removal", () => {
  it("replaces the banner, deletes the old object and invalidates the old URL", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const first = await h.app.request(
      uploadRequest(OWNER, png(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { url: string };
    const firstKey = h.bucket.puts[0]!.key;

    const second = await h.app.request(
      uploadRequest(OWNER, jpg(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { url: string };
    expect(secondBody.url).not.toBe(firstBody.url);
    expect(h.bucket.puts).toHaveLength(2);
    const secondKey = h.bucket.puts[1]!.key;
    expect(secondKey).not.toBe(firstKey);
    expect(h.bucket.deletes).toContain(firstKey);
    expect(h.bucket.objects.has(firstKey)).toBe(false);
    expect(h.bucket.objects.has(secondKey)).toBe(true);

    expect(
      (await h.app.request(new URL(firstBody.url, APP_URL).toString(), undefined, h.bindings))
        .status,
    ).toBe(404);
    const served = await h.app.request(
      new URL(secondBody.url, APP_URL).toString(),
      undefined,
      h.bindings,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/jpeg");
  });

  it("lets the owner delete the banner, removing the object and the row", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const uploaded = await h.app.request(
      uploadRequest(OWNER, png(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(uploaded.status).toBe(200);
    const { url } = (await uploaded.json()) as { url: string };
    const key = h.bucket.puts[0]!.key;

    const deleted = await h.app.request(
      new Request(`${APP_URL}/members/${OWNER}/banner`, {
        method: "DELETE",
        headers: { cookie, accept: "application/json", origin: APP_URL },
      }),
      undefined,
      h.bindings,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true });
    expect(h.bucket.deletes).toContain(key);
    expect(h.bucket.objects.has(key)).toBe(false);
    expect(h.banners.clearCalls).toContain(OWNER);
    expect(h.banners.rows.has(OWNER)).toBe(false);
    expect(
      (await h.app.request(new URL(url, APP_URL).toString(), undefined, h.bindings)).status,
    ).toBe(404);

    const again = await h.app.request(
      new Request(`${APP_URL}/members/${OWNER}/banner`, {
        method: "DELETE",
        headers: { cookie, accept: "application/json", origin: APP_URL },
      }),
      undefined,
      h.bindings,
    );
    expect(again.status).toBe(404);
  });

  it("refuses a moderator deleting someone else's banner with 403", async () => {
    const h = harness();
    const ownerCookie = await cookieFor("owner");
    const uploaded = await h.app.request(
      uploadRequest(OWNER, png(), { cookie: ownerCookie }),
      undefined,
      h.bindings,
    );
    expect(uploaded.status).toBe(200);
    const cookie = await cookieFor("moderator");
    const res = await h.app.request(
      new Request(`${APP_URL}/members/${OWNER}/banner`, {
        method: "DELETE",
        headers: { cookie, accept: "application/json", origin: APP_URL },
      }),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(403);
    expect(h.bucket.deletes).toHaveLength(0);
  });
});

describe("acceptance: moderator banner hide", () => {
  function hideRequest(subjectId: string, cookie: string, action: "hide" | "unhide") {
    return new Request(`${APP_URL}/members/${subjectId}/banner/${action}`, {
      method: "POST",
      headers: { cookie, accept: "application/json", origin: APP_URL },
    });
  }

  it("hides the banner from serving, keeps the object, and restores on unhide", async () => {
    const h = harness();
    const ownerCookie = await cookieFor("owner");
    const uploaded = await h.app.request(
      uploadRequest(OWNER, png(), { cookie: ownerCookie }),
      undefined,
      h.bindings,
    );
    expect(uploaded.status).toBe(200);
    const { url } = (await uploaded.json()) as { url: string };
    const key = h.bucket.puts[0]!.key;

    const modCookie = await cookieFor("moderator");
    const hidden = await h.app.request(
      hideRequest(OWNER, modCookie, "hide"),
      undefined,
      h.bindings,
    );
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({ hidden: true });
    expect(h.banners.rows.get(OWNER)?.hidden).toBe(true);
    expect(h.bucket.deletes).toHaveLength(0);
    expect(h.bucket.objects.has(key)).toBe(true);
    expect(h.audits).toEqual([{ action: "banner.hide", moderatorId: MODERATOR, subjectId: OWNER }]);
    expect(
      (await h.app.request(new URL(url, APP_URL).toString(), undefined, h.bindings)).status,
    ).toBe(404);

    const restored = await h.app.request(
      hideRequest(OWNER, modCookie, "unhide"),
      undefined,
      h.bindings,
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ hidden: false });
    expect(h.banners.rows.get(OWNER)?.hidden).toBe(false);
    expect(h.audits).toEqual([
      { action: "banner.hide", moderatorId: MODERATOR, subjectId: OWNER },
      { action: "banner.unhide", moderatorId: MODERATOR, subjectId: OWNER },
    ]);
    expect(
      (await h.app.request(new URL(url, APP_URL).toString(), undefined, h.bindings)).status,
    ).toBe(200);
  });

  it("refuses hide/unhide to non-moderators, including the owner", async () => {
    const h = harness();
    const ownerCookie = await cookieFor("owner");
    const uploaded = await h.app.request(
      uploadRequest(OWNER, png(), { cookie: ownerCookie }),
      undefined,
      h.bindings,
    );
    expect(uploaded.status).toBe(200);
    for (const actor of ["owner", "other"] as const) {
      const cookie = await cookieFor(actor);
      for (const action of ["hide", "unhide"] as const) {
        const res = await h.app.request(hideRequest(OWNER, cookie, action), undefined, h.bindings);
        expect(res.status, `${actor}/${action}`).toBe(403);
      }
    }
    const guestHide = await h.app.request(
      new Request(`${APP_URL}/members/${OWNER}/banner/hide`, {
        method: "POST",
        headers: { accept: "application/json", origin: APP_URL },
      }),
      undefined,
      h.bindings,
    );
    expect(guestHide.status).toBe(401);
    expect(h.audits).toHaveLength(0);
    expect(h.banners.rows.get(OWNER)?.hidden).toBe(false);
  });

  it("answers hide on a bannerless member with 404 and writes no audit", async () => {
    const h = harness();
    const ownerCookie = await cookieFor("owner");
    const uploaded = await h.app.request(
      uploadRequest(OWNER, png(), { cookie: ownerCookie }),
      undefined,
      h.bindings,
    );
    expect(uploaded.status).toBe(200);
    const modCookie = await cookieFor("moderator");
    const hidden = await h.app.request(
      hideRequest(OWNER, modCookie, "hide"),
      undefined,
      h.bindings,
    );
    expect(hidden.status).toBe(200);
    const res = await h.app.request(hideRequest(OTHER, modCookie, "hide"), undefined, h.bindings);
    expect(res.status).toBe(404);
    expect(h.audits).toHaveLength(1);
  });
});

describe("acceptance: banner erasure deletes the stored object", () => {
  function fakeErasureSql(bannerKey: string | null) {
    const deletes: string[] = [];
    const tx = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join("?");
      if (/^\s*select/i.test(text) && /banner/i.test(text))
        return bannerKey ? [{ key: bannerKey, banner_key: bannerKey }] : [];
      if (/^\s*delete/i.test(text)) {
        deletes.push(text);
        if (/profiles/i.test(text) && bannerKey) return [{ key: bannerKey, banner_key: bannerKey }];
        return [{ "?column?": 1 }];
      }
      if (/count/i.test(text)) return [{ n: 0 }];
      return [];
    }) as unknown as ErasureSql;
    tx.begin = async <T>(fn: (tx: typeof tx) => Promise<T>): Promise<T> => fn(tx);
    return { sql: tx, deletes };
  }

  it("deletes the banner object on apply, never on dry-run or when absent", async () => {
    const key = `banners/${OWNER}/opaque-version-token.png`;
    const { sql } = fakeErasureSql(key);
    const bucket = new FakeBannerBucket();
    await bucket.put(key, fixture("banner-valid.png"), {
      httpMetadata: { contentType: "image/png" },
    });

    const opts = { dryRun: false, banners: bucket } as ErasureOptsWithBucket;
    await eraseMember(sql, OWNER, opts);
    expect(bucket.deletes).toContain(key);
    expect(bucket.objects.has(key)).toBe(false);
  });

  it("CONTROL: dry-run and bannerless erasure delete nothing", async () => {
    const key = `banners/${OWNER}/opaque-version-token.png`;
    const dryBucket = new FakeBannerBucket();
    await dryBucket.put(key, fixture("banner-valid.png"));
    const dryOpts = { dryRun: true, banners: dryBucket } as ErasureOptsWithBucket;
    await eraseMember(fakeErasureSql(key).sql, OWNER, dryOpts);
    expect(dryBucket.deletes).toHaveLength(0);

    const emptyBucket = new FakeBannerBucket();
    const emptyOpts = { dryRun: false, banners: emptyBucket } as ErasureOptsWithBucket;
    await eraseMember(fakeErasureSql(null).sql, OWNER, emptyOpts);
    expect(emptyBucket.deletes).toHaveLength(0);
  });
});

describe("CONTROL: surrounding contract", () => {
  // The profile gate runs before routing, so these hold at base and must
  // hold after: the banner POST stays behind the same write gate.
  it("refuses guest uploads with 401 and writes nothing", async () => {
    const h = harness();
    const res = await h.app.request(uploadRequest(OWNER, png()), undefined, h.bindings);
    expect(res.status).toBe(401);
    expect(h.bucket.puts).toHaveLength(0);
    expect(h.banners.setCalls).toHaveLength(0);
  });

  it("refuses non-member uploads with 403", async () => {
    const h = harness();
    const cookie = await cookieFor("outsider");
    const res = await h.app.request(
      uploadRequest(OUTSIDER, png(), { cookie }),
      undefined,
      h.bindings,
    );
    expect(res.status).toBe(403);
    expect(h.bucket.puts).toHaveLength(0);
  });

  it("forged origins stay rejected on unsafe banner methods", async () => {
    const h = harness();
    const cookie = await cookieFor("owner");
    const res = await h.app.request(
      uploadRequest(OWNER, png(), { cookie, origin: "https://evil.example.test" }),
      undefined,
      h.bindings,
    );
    // The global same-origin guard answers before routing; this pins that the
    // banner POST stays behind it rather than joining the exemptions.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross_origin" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "acceptance: banner upload budget (agent-testdb)",
  () => {
    it("allows 10 uploads/min/member, then 429s on the real throttle store", async () => {
      const userId = `900002${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 900) + 100)}`;
      cookieForStore = createMemorySessionStore();
      const sessions = cookieForStore;
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId,
        username: "budget-member",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const cookie = (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
          path: "/",
          secure: true,
        })
      ).split(";")[0]!;
      const bucket = new FakeBannerBucket();
      const banners = memoryBannerStore();
      // No throttle double: the Builder's banner admission must fall back to
      // the real checkJoinThrottle store like profile writes do.
      const deps: BannerDeps = {
        sessionStore: sessions,
        store: {
          find: async (id: string) => (id === userId ? memberRow(id) : null),
          save: async () => {},
        },
        bannerStore: banners,
      };
      const app = new Hono<{ Bindings: BindingsWithBucket }>();
      app.route("/", profilesApp(deps));
      const bindings = { ...env, BANNER_BUCKET: bucket } as BindingsWithBucket;
      for (let n = 1; n <= 10; n++) {
        const res = await app.request(
          uploadRequest(userId, png(), { cookie }),
          undefined,
          bindings,
        );
        expect(res.status, `upload ${n}`).toBe(200);
      }
      const limited = await app.request(
        uploadRequest(userId, png(), { cookie }),
        undefined,
        bindings,
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    });
  },
);
