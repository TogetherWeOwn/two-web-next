import { describe, expect, it } from "vitest";
import { acceptsGzip } from "../src/accept-encoding";

describe("acceptsGzip", () => {
  it.each<[string | null, boolean]>([
    [null, false],
    ["", false],
    ["br", false],
    ["gzip", true],
    ["GZip; q=0.5", true],
    ["gzip;q=0", false],
    ["gzip;q=0.000", false],
    ["*", true],
    ["*;q=0", false],
    ["br, *;q=0.5", true],
    ["gzip;q=0, *;q=1", false],
    ["*;q=1, gzip;q=0", false],
    ["gzip;q=1, *;q=0", true],
    ["*;q=0, gzip;q=1", true],
    ["gzip;q=bogus, *;q=1", false],
    ["gzip;q=1.5", false],
    ["gzip;q=0.0001", false],
    ["gzip;q=", false],
    ["gzip;q=1, gzip;q=0", false],
    ["gzip;q=0, gzip;q=1", false],
    ["gzip;q=1;q=0", false],
  ])("negotiates %s as %s", (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });
});
