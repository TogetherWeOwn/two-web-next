import fc from "fast-check";
import { generateSignedCookie } from "hono/cookie";
import { parseSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import {
  setSignedEventCookie,
  signedCookieHeader,
  verifySignedCookie,
} from "../src/http/signed-cookie";
import { SESSION_COOKIE as name } from "../src/session-cookie";
import fixture from "./fixtures/parity/signed-cookies.json";

const { secret, cookies } = fixture;
const options = { ...fixture.options, sameSite: "Lax" as const };
const pair = (header: string) => header.slice(0, header.indexOf(";"));
const wire = (header: string, name: string) => pair(header).slice(name.length + 1);

describe("signed cookie wire compatibility", () => {
  it.each(cookies)("reproduces the $name fixture bytes", async ({ name, vectors }) => {
    for (const { value, cookieValue, header } of vectors) {
      expect(await signedCookieHeader(name, value, secret)).toBe(header);
      expect(await verifySignedCookie(cookieValue, secret)).toBe(value);
    }
  });

  it.each(cookies)("interoperates with Hono for 1,000 generated $name values", async ({ name }) => {
    const set = vi.fn<Parameters<typeof setSignedEventCookie>[0]["set"]>();
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "grapheme", maxLength: 48 }), async (value) => {
        const maxAge = 120;
        const hono = await generateSignedCookie(name, value, secret, { ...options, maxAge });
        const raw = await signedCookieHeader(name, value, secret, maxAge);
        expect(raw).toBe(hono);
        expect(await verifySignedCookie(wire(hono, name), secret)).toBe(value);
        expect((await parseSigned(pair(raw), secret, name))[name]).toBe(value);

        set.mockClear();
        await setSignedEventCookie({ set }, name, value, secret, maxAge);
        expect(set).toHaveBeenCalledExactlyOnceWith(name, wire(hono, name), {
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          maxAge,
          encode: expect.any(Function),
        });
        const call = set.mock.calls[0];
        if (!call) throw new Error("Expected a cookie write");
        const [writtenName, encoded, { encode }] = call;
        const kitPair = `${writtenName}=${encode(encoded)}`;
        expect(kitPair).toBe(pair(hono));
        expect((await parseSigned(kitPair, secret, name))[name]).toBe(value);
      }),
      { numRuns: 1000, seed: 94273 },
    );
  });

  it("refuses malformed values and invalid signatures", async () => {
    const value = "signed.% café";
    const encoded = wire(await signedCookieHeader(name, value, secret), name);
    for (const bad of ["", "%FF", "unsigned", "value.not-a-mac", `changed${encoded}`]) {
      expect(await verifySignedCookie(bad, secret)).toBeNull();
    }
    expect(await verifySignedCookie(encoded, `${secret}-other`)).toBeNull();
    expect(await verifySignedCookie(encoded, "")).toBeNull();
  });

  it("enforces the host-only scope and bounded lifetime on both writers", async () => {
    const set = vi.fn();
    for (const invalid of [
      "two_session",
      "__Host-two_session;Domain=other",
      "__Host-two_session\n",
    ]) {
      await expect(signedCookieHeader(invalid, "value", secret)).rejects.toThrow("cookie name");
      await expect(setSignedEventCookie({ set }, invalid, "value", secret)).rejects.toThrow(
        "cookie name",
      );
    }
    for (const maxAge of [-1, 0.5, Number.NaN, 34_560_001]) {
      await expect(signedCookieHeader(name, "value", secret, maxAge)).rejects.toThrow("Max-Age");
      await expect(setSignedEventCookie({ set }, name, "value", secret, maxAge)).rejects.toThrow(
        "Max-Age",
      );
    }
    expect(set).not.toHaveBeenCalled();
    await setSignedEventCookie({ set }, name, "value", secret);
    expect(set).toHaveBeenCalledExactlyOnceWith(name, expect.any(String), {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      encode: expect.any(Function),
    });
    expect(await signedCookieHeader(name, "value", secret, 0)).toContain("; Max-Age=0;");
  });
});
