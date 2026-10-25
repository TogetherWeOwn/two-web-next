import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { REFUSAL_CODES, jsonRefusal } from "../src/json-refusal";

function app(requestId?: string) {
  const a = new Hono<{ Variables: { requestId: string } }>();
  a.use("*", async (c, next) => {
    if (requestId !== undefined) c.set("requestId", requestId);
    await next();
  });
  a.get("/plain", (c) => jsonRefusal(c, "forbidden", 403));
  a.get("/extra", (c) =>
    jsonRefusal(c, "invalid", 422, { fields: { status: ["status is invalid"] } }),
  );
  return a;
}

describe("jsonRefusal", () => {
  it("emits error and request_id with the status", async () => {
    const res = await app("0123456789abcdef-LHR").request("/plain");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", request_id: "0123456789abcdef-LHR" });
  });

  it("omits request_id without a requestLog context", async () => {
    expect(await (await app().request("/plain")).json()).toEqual({ error: "forbidden" });
  });

  it("never echoes an unvalidated request id", async () => {
    const res = await app("bad id with spaces <script>").request("/plain");
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("merges extra keys after the code", async () => {
    const res = await app("0123456789abcdef-LHR").request("/extra");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid",
      request_id: "0123456789abcdef-LHR",
      fields: { status: ["status is invalid"] },
    });
  });
});

describe("vocabulary", () => {
  it("is the fixed, sorted, lowercase set", () => {
    expect([...REFUSAL_CODES]).toEqual([
      "cross_origin",
      "forbidden",
      "invalid",
      "method_not_allowed",
      "not_found",
      "unauthenticated",
      "unsupported_media_type",
    ]);
  });
});
