import { describe, expect, it } from "vitest";
import {
  checkAdmissionInput,
  guard,
  KitLockAdmissionError,
  refuse,
} from "../web/scripts/kit-lock-admission-policy.mjs";

const env = { platform: "linux", nodeVersion: "24.0.0" };

describe("Kit lock admission input policy", () => {
  it.each(["darwin", "win32", "freebsd"])("refuses platform %s", (platform) => {
    expect(() => checkAdmissionInput({ ...env, platform }, "/safe/lock")).toThrow(
      "kit lock admission: Linux is required",
    );
  });

  it.each(["22.23.0", "22.24.0", "24.0.0", "25.0.0"])("accepts Node %s", (nodeVersion) => {
    expect(() => checkAdmissionInput({ ...env, nodeVersion }, "/safe/lock")).not.toThrow();
  });

  it.each(["20.99.0", "22.22.9", "23.99.0", "invalid", "22"])("refuses Node %s", (nodeVersion) => {
    expect(() => checkAdmissionInput({ ...env, nodeVersion }, "/safe/lock")).toThrow(
      "kit lock admission: Node 22.23+ on 22, or 24+, is required",
    );
  });

  it.each([null, undefined, 42, {}, "", "relative/path", "/safe//lock", "/safe/../lock", "/safe/"])(
    "refuses malformed, relative or unnormalized path %s",
    (path) => {
      expect(() => checkAdmissionInput(env, path)).toThrow(
        "kit lock admission: an absolute normalized path is required",
      );
    },
  );

  it("refuses the filesystem root", () => {
    expect(() => checkAdmissionInput(env, "/")).toThrow(
      "kit lock admission: filesystem root is refused",
    );
  });
});

describe("Kit lock admission failures", () => {
  it("preserves the error name, prefix and optional cause", () => {
    const cause = new Error("underlying");
    const error = new KitLockAdmissionError("denied", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("KitLockAdmissionError");
    expect(error.message).toBe("kit lock admission: denied");
    expect(error.cause).toBe(cause);
    expect(new KitLockAdmissionError("denied").cause).toBeUndefined();
  });

  it("refuses with the original cause, including non-Error values", () => {
    const cause = { code: "failure" };
    expect(() => refuse("denied", cause)).toThrow(
      expect.objectContaining({
        name: "KitLockAdmissionError",
        message: "kit lock admission: denied",
        cause,
      }),
    );
    expect(() => refuse("denied")).toThrow(expect.objectContaining({ cause: undefined }));
  });

  it("returns successful results and wraps failures without double wrapping", () => {
    expect(guard("operation", () => 42)).toBe(42);
    const cause = new Error("underlying");
    expect(() =>
      guard("operation", () => {
        throw cause;
      }),
    ).toThrow(expect.objectContaining({ message: "kit lock admission: operation failed", cause }));
    const existing = new KitLockAdmissionError("already denied");
    try {
      guard("operation", () => {
        throw existing;
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBe(existing);
    }
  });
});
