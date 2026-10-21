import { describe, expect, it } from "vitest";
import { featuredLinkRefusal, isSafeFeaturedLink } from "../src/image-policy";

describe("featured link policy", () => {
  it.each([
    ["https://trusted.example@evil.example/", "userinfo"],
    ["https://example.test/a\\b", "backslash"],
    ["https://example.test/a b", "whitespace"],
    ["https://example.test/a\u0001b", "control"],
    ["https://example.test/a\u0085b", "control"],
  ])("names the rule for %j", (raw, rule) => {
    expect(featuredLinkRefusal(raw)).toBe(rule);
    expect(isSafeFeaturedLink(raw)).toBe(false);
  });

  it.each(["https://example.test:8443/p?q=1#f", "http://example.test/team@home"])(
    "accepts %s, ports included",
    (raw) => {
      expect(featuredLinkRefusal(raw)).toBeNull();
      expect(isSafeFeaturedLink(raw)).toBe(true);
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "//example.test/x",
    "/events",
    "mailto:a@b.c",
  ])("is not a safe absolute http(s) link: %s", (raw) => {
    expect(isSafeFeaturedLink(raw)).toBe(false);
  });
});
