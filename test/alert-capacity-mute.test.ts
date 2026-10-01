import { describe, expect, it } from "vitest";
import { ALERT_WINDOW_MS, AlertRateLimit, alertRequestError } from "../src/alerts";

class BoomError extends Error {}

function fixture() {
  let t = 1_000;
  const limiter = new AlertRateLimit(ALERT_WINDOW_MS, () => t);
  const lines: string[] = [];
  const emit = (route: string, err: unknown = new BoomError("private SQL values\nsecond line")) =>
    alertRequestError(err, { method: "GET", route }, { limiter, sink: (line) => void lines.push(line) });
  const size = () => (limiter as unknown as { last: Map<string, number> }).last.size;
  return { emit, lines, size, advance: (ms: number) => { t += ms; } };
}

describe("alert capacity mute", () => {
  it("declines overflow rather than evicting the oldest live fingerprint", () => {
    const f = fixture();
    for (let i = 0; i < 500; i++) expect(f.emit(`/tracked/${i}`)).toBe(true);

    const overflow = f.emit("/overflow");
    expect(f.emit("/tracked/0")).toBe(false);
    expect(overflow).toBe(false);
    expect(f.emit("/tracked/499")).toBe(false);
    expect(f.lines).toHaveLength(500);
    expect(f.size()).toBe(500);
  });

  it("preserves admitted fingerprints and the storage bound under sustained churn", () => {
    const f = fixture();
    for (let i = 0; i < 500; i++) expect(f.emit(`/tracked/${i}`)).toBe(true);

    for (let i = 0; i < 2_000; i++) {
      f.advance(100);
      expect(f.emit(`/overflow/${i}`)).toBe(false);
      expect(f.emit(`/tracked/${i % 500}`)).toBe(false);
      expect(f.size()).toBe(500);
    }
    f.advance(ALERT_WINDOW_MS - 200_000 - 1);
    expect(f.emit("/tracked/0")).toBe(false);
    expect(f.lines).toHaveLength(500);

    f.advance(1);
    expect(f.emit("/tracked/0")).toBe(true);
    expect(f.size()).toBe(1);
    expect(f.lines).toHaveLength(501);
  });

  it("reclaims only expired slots at the exact window boundary", () => {
    const f = fixture();
    expect(f.emit("/oldest")).toBe(true);
    f.advance(1);
    for (let i = 0; i < 499; i++) expect(f.emit(`/later/${i}`)).toBe(true);

    f.advance(ALERT_WINDOW_MS - 2);
    expect(f.emit("/overflow")).toBe(false);
    expect(f.emit("/oldest")).toBe(false);
    f.advance(1);
    expect(f.emit("/overflow")).toBe(true);
    expect(f.emit("/another-overflow")).toBe(false);
    expect(f.emit("/later/0")).toBe(false);
    expect(f.emit("/later/498")).toBe(false);
    expect(f.size()).toBe(500);
    expect(f.lines).toHaveLength(501);

    f.advance(1);
    expect(f.emit("/another-overflow")).toBe(true);
    expect(f.emit("/overflow")).toBe(false);
    expect(f.size()).toBe(2);
    expect(f.lines).toHaveLength(502);
  });

  it("finds an expired slot even behind a renewed entry in insertion order", () => {
    const f = fixture();
    expect(f.emit("/renewed")).toBe(true);
    f.advance(1);
    expect(f.emit("/expires-next")).toBe(true);
    f.advance(ALERT_WINDOW_MS - 1);
    expect(f.emit("/renewed")).toBe(true);
    for (let i = 0; i < 498; i++) expect(f.emit(`/fresh/${i}`)).toBe(true);
    expect(f.emit("/overflow")).toBe(false);

    f.advance(1);
    expect(f.emit("/overflow")).toBe(true);
    expect(f.emit("/renewed")).toBe(false);
    expect(f.emit("/fresh/0")).toBe(false);
    expect(f.emit("/another-overflow")).toBe(false);
    expect(f.size()).toBe(500);
    expect(f.lines).toHaveLength(502);
  });

  it("keeps ordinary fingerprints independent and alert payloads private and single-line", () => {
    const f = fixture();
    expect(f.emit("/a")).toBe(true);
    expect(f.emit("/a")).toBe(false);
    expect(f.emit("/b")).toBe(true);
    expect(f.emit("/a", new TypeError("other private message"))).toBe(true);
    expect(f.lines).toHaveLength(3);
    for (const line of f.lines) {
      expect(line).not.toContain("\n");
      expect(line).not.toContain("private");
    }
    expect(JSON.parse(f.lines[0]!)).toEqual({
      level: "critical",
      event: "error.alert",
      fingerprint: "BoomError@/a",
      exception: "BoomError",
      method: "GET",
      route: "/a",
    });
  });

  it("does not consume capacity or write lines for dont-report errors", () => {
    const f = fixture();
    for (let i = 0; i < 500; i++) {
      expect(f.emit(`/client/${i}`, { status: 404 })).toBe(false);
      expect(f.emit(`/validation/${i}`, { name: "ZodError" })).toBe(false);
    }
    expect(f.size()).toBe(0);
    expect(f.lines).toHaveLength(0);
    for (let i = 0; i < 500; i++) expect(f.emit(`/tracked/${i}`)).toBe(true);
    expect(f.size()).toBe(500);
    expect(f.lines).toHaveLength(500);
  });
});
