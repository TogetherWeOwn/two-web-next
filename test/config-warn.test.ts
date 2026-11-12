import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

const settings = [
  "FEATURED_IMAGE_HOSTS",
  "E2E_PUBLIC_READ_BUDGET",
  "AGENT_EVENTS_ROUTE_PER_MINUTE",
  "CSP_REPORT_SAMPLE_RATE",
] as const;

describe("bounded operator configuration diagnostics", () => {
  it("emits at most four fixed-key warnings per isolate", async () => {
    const { warnInvalidConfigOnce } = await import("../src/config-warn");
    for (let i = 0; i < 100; i += 1) {
      for (const variable of settings) warnInvalidConfigOnce(variable);
    }
    expect(vi.mocked(console.warn).mock.calls).toEqual(
      settings.map((variable) => [
        "operator.config.invalid",
        {
          variable,
          action: variable === "FEATURED_IMAGE_HOSTS" ? "ignored_entries" : "using_default",
        },
      ]),
    );
  });

  it("retries a failed logger without changing fallback serving", async () => {
    const { operatorImageHosts } = await import("../src/config-warn");
    const warn = vi.mocked(console.warn).mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    for (let i = 0; i < 3; i += 1) {
      expect(operatorImageHosts("*.evil.com")).toEqual(["cdn.discordapp.com"]);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("warns again in a new isolate", async () => {
    const first = await import("../src/config-warn");
    first.operatorImageHosts("*.evil.com");
    vi.resetModules();
    const second = await import("../src/config-warn");
    second.operatorImageHosts("*.evil.com");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe("featured host diagnostics use the shared parser on the server", () => {
  it.each([undefined, "", " \t\n", ", ,", "Images.Unsplash.Com,images.unsplash.com,"])(
    "keeps valid, unset and blank lists silent: %j",
    async (raw) => {
      const { operatorImageHosts } = await import("../src/config-warn");
      const { imageHosts } = await import("../src/image-policy");
      expect(operatorImageHosts(raw)).toEqual(imageHosts(raw));
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it("ignores invalid entries without discarding valid hosts or exposing values", async () => {
    const { operatorImageHosts } = await import("../src/config-warn");
    const { isFeaturedImageUrl } = await import("../src/image-policy");
    const credential = "fixture-password-marker";
    const raw = `images.unsplash.com,https://user:${credential}@evil.com/image?token=fixture-query-marker#fragment,*.evil.com,localhost,127.0.0.1`;
    for (const configured of [raw, "*.another.com", raw]) {
      expect(operatorImageHosts(configured)).toEqual(
        configured === raw ? ["cdn.discordapp.com", "images.unsplash.com"] : ["cdn.discordapp.com"],
      );
    }
    expect(isFeaturedImageUrl("https://images.unsplash.com/image", raw)).toBe(true);
    expect(isFeaturedImageUrl("https://evil.com/image", raw)).toBe(false);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["operator.config.invalid", { variable: "FEATURED_IMAGE_HOSTS", action: "ignored_entries" }],
    ]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(credential);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "fixture-query-marker",
    );
  });

  it("compacts a large distinct-entry flood into one warning", async () => {
    const { operatorImageHosts } = await import("../src/config-warn");
    const raw = Array.from({ length: 1583 }, (_, i) => `*.bad${i}.com`).join(",");
    expect(operatorImageHosts(raw)).toEqual(["cdn.discordapp.com"]);
    expect(operatorImageHosts(raw)).toEqual(["cdn.discordapp.com"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("leaves client-side image validation free of diagnostics", async () => {
    const { imageHosts, isFeaturedImageUrl } = await import("../src/image-policy");
    expect(imageHosts("*.evil.com")).toEqual(["cdn.discordapp.com"]);
    expect(isFeaturedImageUrl("https://evil.com/image", "*.evil.com")).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
