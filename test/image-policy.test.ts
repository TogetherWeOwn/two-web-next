import { describe, expect, it } from "vitest";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import { imageHosts, isFeaturedImageUrl } from "../src/image-policy";

const fields = (image_url: string) => ({
  title: "Featured",
  image_url,
  image_alt: "Players together",
});
const configured = "images.unsplash.com";

function imageError(url: string, hosts?: string): void {
  try {
    parseFeaturedForm(fields(url), hosts);
    expect.fail("Expected an image_url field error");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fields.image_url).toContain("HTTPS on an approved public host");
  }
}

describe("featured image policy (local fixtures)", () => {
  it("defaults to the existing Discord CDN, never arbitrary HTTPS hosts", () => {
    expect(imageHosts()).toEqual(["cdn.discordapp.com"]);
    expect(parseFeaturedForm(fields("https://cdn.discordapp.com/photo.png")).imageUrl).toBe(
      "https://cdn.discordapp.com/photo.png",
    );
    imageError("https://images.unsplash.com/photo.png");
    expect(parseFeaturedForm({ title: "No image", image_url: " " }).imageUrl).toBeNull();
  });

  it("accepts approved HTTPS hosts exactly (including the default HTTPS port)", () => {
    for (const url of [
      "https://images.unsplash.com/photo.png",
      "HTTPS://IMAGES.UNSPLASH.COM/photo.png",
      "https://images.unsplash.com:443/photo.png",
    ]) {
      expect(parseFeaturedForm(fields(url), configured).imageUrl).toBe(url);
    }
    imageError("https://sub.images.unsplash.com/photo.png", configured);
    imageError("https://images.unsplash.com.evil.com/photo.png", configured);
    imageError("https://images.unsplash.com:8443/photo.png", configured);
  });

  it.each([
    "http://cdn.discordapp.com/photo.png",
    "//cdn.discordapp.com/photo.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "not a url",
    "https://user:password@cdn.discordapp.com/photo.png",
    "https://cdn.discordapp.com@evil.com/photo.png",
    "https://cdn.discordapp.com\\@evil.com/photo.png",
    "https://cdn.discordapp.com\n/photo.png",
    "https://cdn.discordapp.com./photo.png",
    "https://cdn.discordapp.com/" + "a".repeat(255),
  ])("returns an image_url field error for %s", (url) => imageError(url, configured));

  it.each([
    "https://@cdn.discordapp.com/photo.png",
    "https://:@cdn.discordapp.com/photo.png",
    "https://@images.unsplash.com/photo.png",
  ])("returns an image_url field error for empty userinfo %s", (url) =>
    imageError(url, configured),
  );

  it("refuses wildcard hosts in cover URLs and drops them from configuration", () => {
    expect(imageHosts("*.evil.com")).toEqual(["cdn.discordapp.com"]);
    imageError("https://*.evil.com/photo.png", "*.evil.com");
    imageError("https://evil.com/photo.png", "*.evil.com");
  });

  it("refuses non-default ports and non-HTTPS schemes on approved hosts", () => {
    imageError("https://cdn.discordapp.com:80/photo.png", configured);
    imageError("https://images.unsplash.com:8443/photo.png", configured);
    imageError("ftp://images.unsplash.com/photo.png", configured);
  });

  it.each([
    "localhost",
    "a.localhost",
    "internal",
    "a.local",
    "a.internal",
    "a.lan",
    "a.home",
    "a.test",
    "a.invalid",
    "a.example",
    "a.onion",
    "a.arpa",
    "localdomain",
    "localhost.localdomain",
    "cdn.localhost.localdomain",
    "alt",
    "images.alt",
    "cdn.images.alt",
    "corp",
    "images.corp",
    "cdn.images.corp",
    "mail",
    "images.mail",
    "cdn.images.mail",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "8.8.8.8",
    "[::1]",
    "[fc00::1]",
    "[::ffff:127.0.0.1]",
    "[2001:4860:4860::8888]",
  ])("rejects private/reserved names and all IP spellings, even if configured: %s", (host) => {
    imageError(`https://${host}/photo.png`, host);
    expect(imageHosts(host)).toEqual(["cdn.discordapp.com"]);
  });

  it("ignores malformed configuration instead of injecting CSP expressions", () => {
    expect(
      imageHosts(
        " Images.Unsplash.Com,images.unsplash.com,https://evil.com,*.evil.com,evil.com:443,evil.com/path,evil.com; script-src *,user@evil.com,,localhost,127.0.0.1",
      ),
    ).toEqual(["cdn.discordapp.com", "images.unsplash.com"]);
  });

  it("preserves link validation and the required image description", () => {
    expect(parseFeaturedForm({ title: "Link", url: "http://example.com" }).url).toBe(
      "http://example.com",
    );
    expect(() =>
      parseFeaturedForm({ title: "Photo", image_url: "https://cdn.discordapp.com/photo.png" }),
    ).toThrowError(ValidationError);
    expect(isFeaturedImageUrl("https://cdn.discordapp.com/photo.png")).toBe(true);
  });
});
