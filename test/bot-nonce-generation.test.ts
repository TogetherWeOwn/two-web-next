import { afterEach, describe, expect, it, vi } from "vitest";
import { newNonce } from "../src/bot/signer";

// Controlled bytes pin the wire encoding, not the statistical quality of Web Crypto.
afterEach(() => vi.restoreAllMocks());

function fillNonceBytes(array: ArrayBufferView | null, bytes: readonly number[]) {
  expect(array).toBeInstanceOf(Uint8Array);
  if (!(array instanceof Uint8Array)) throw new Error("expected Uint8Array nonce entropy");
  expect(array.length).toBe(16);
  expect(array.byteLength).toBe(16);
  array.set(bytes);
  return array;
}

describe("newNonce", () => {
  it.each([
    {
      name: "leading zeros, high-bit bytes and 0xff",
      bytes: [
        0x00, 0x01, 0x09, 0x0a, 0x0f, 0x10, 0x7f, 0x80, 0x81, 0x9a, 0xab, 0xcd, 0xef, 0xfe, 0xff,
        0x00,
      ],
      expected: "0001090a0f107f80819aabcdeffeff00",
    },
    {
      name: "all-zero bytes without dropping padding",
      bytes: Array(16).fill(0),
      expected: "00000000000000000000000000000000",
    },
  ])("encodes $name from one 16-byte Web Crypto request", ({ bytes, expected }) => {
    const entropy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) => fillNonceBytes(array, bytes));

    const nonce = newNonce();

    expect(entropy).toHaveBeenCalledOnce();
    expect(nonce).toBe(expected);
    expect(nonce).toHaveLength(32);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("requests a fresh byte array on each call instead of reusing a cached nonce", () => {
    const entropy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementationOnce((array) => fillNonceBytes(array, Array(16).fill(0x01)))
      .mockImplementationOnce((array) => fillNonceBytes(array, Array(16).fill(0xff)));

    expect(newNonce()).toBe("01010101010101010101010101010101");
    expect(newNonce()).toBe("ffffffffffffffffffffffffffffffff");
    expect(entropy).toHaveBeenCalledTimes(2);
    const first = entropy.mock.calls[0]![0];
    const second = entropy.mock.calls[1]![0];
    expect(second).not.toBe(first);
    expect(second!.buffer).not.toBe(first!.buffer);
  });

  it("propagates the entropy failure even after success, with no cached or weak fallback", () => {
    const failure = new Error("fixture Web Crypto failure");
    const entropy = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementationOnce((array) => fillNonceBytes(array, Array(16).fill(0xab)))
      .mockImplementationOnce(() => {
        throw failure;
      });
    const weakRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const timestamp = vi.spyOn(Date, "now").mockReturnValue(1787173135000);

    expect(newNonce()).toBe("abababababababababababababababab");
    let thrown: unknown;
    try {
      newNonce();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(entropy).toHaveBeenCalledTimes(2);
    expect(weakRandom).not.toHaveBeenCalled();
    expect(timestamp).not.toHaveBeenCalled();
  });
});
