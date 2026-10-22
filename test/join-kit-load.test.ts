import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import type { DiscordWidgetSnapshot } from "../src/discord-widget";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { applyJoinPageResponsePolicy } from "../src/join/kit-page";

const SECRET = "join-kit-load-test-secret";

async function signedFlash(result: "added" | "already_member"): Promise<string> {
  return (
    await serializeSigned(JOIN_RESULT_COOKIE, result, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

function responseHarness(request: Request, snapshot: DiscordWidgetSnapshot | null = null) {
  const deleted: Array<{ name: string; options: Record<string, unknown> }> = [];
  const headers: Record<string, string> = {};
  const journey = applyJoinPageResponsePolicy({
    request,
    sessionSecret: SECRET,
    snapshot,
    cookies: {
      delete: (name, options) => deleted.push({ name, options }),
    },
    setHeaders: (values) => Object.assign(headers, values),
  });
  return { journey, deleted, headers };
}

describe("Kit GET /join response policy", () => {
  it("makes a signed flash private and deletes it with host-cookie attributes", async () => {
    const cookie = await signedFlash("added");
    const { journey, deleted, headers } = responseHarness(
      new Request("https://example.test/join", {
        headers: { cookie },
      }),
    );

    await expect(journey).resolves.toEqual({ joinResult: "added" });
    expect(headers).toEqual({
      "cache-control": "private, no-store",
      vary: "Cookie",
    });
    expect(deleted).toEqual([
      {
        name: JOIN_RESULT_COOKIE,
        options: {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        },
      },
    ]);
  });

  it("leaves HEAD flash pending and keeps the public 60-second TTL", async () => {
    const cookie = await signedFlash("already_member");
    const { journey, deleted, headers } = responseHarness(
      new Request("https://example.test/join", {
        method: "HEAD",
        headers: { cookie },
      }),
    );

    await expect(journey).resolves.toEqual({ joinResult: null });
    expect(headers).toEqual({
      "cache-control": "public, max-age=60",
      vary: "Cookie",
    });
    expect(deleted).toEqual([]);
  });

  it("keeps a presence snapshot on the shared 60-second TTL", async () => {
    const snapshot = {
      guildId: "326474832151838730",
      name: "Together We Own",
      inviteUrl: null,
      presenceCount: 42,
      channels: [],
      members: [],
      fetchedAt: 0,
    } satisfies DiscordWidgetSnapshot;
    const { journey, deleted, headers } = responseHarness(
      new Request("https://example.test/join"),
      snapshot,
    );

    await expect(journey).resolves.toEqual({ joinResult: null });
    expect(headers).toEqual({
      "cache-control": "public, max-age=60",
      vary: "Cookie",
    });
    expect(deleted).toEqual([]);
  });

  it("keeps a request without a flash public and does not emit a delete", async () => {
    const { journey, deleted, headers } = responseHarness(new Request("https://example.test/join"));

    await expect(journey).resolves.toEqual({ joinResult: null });
    expect(headers).toEqual({
      "cache-control": "public, max-age=60",
      vary: "Cookie",
    });
    expect(deleted).toEqual([]);
  });
});
