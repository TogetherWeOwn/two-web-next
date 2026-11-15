// Runtime design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import { describe, expect, it, vi } from "vitest";
import { createKitWorkerFacade, KIT_WORKER_FACADE } from "../src/kit-worker-facade";

const env = { APP_URL: "https://togetherweown.com" };
const req = () => new Request("https://togetherweown.com/about");
const passthrough = async (_request: Request, response: Response) => response;

describe("createKitWorkerFacade", () => {
  it("delegates fetch once with the real adapter as receiver and unchanged arguments", async () => {
    const seen: unknown[] = [];
    const adapter = {
      async fetch(this: unknown, ...args: unknown[]) {
        seen.push(this, ...args);
        return new Response("ok");
      },
    };
    const protect = vi.fn(passthrough);
    const facade = createKitWorkerFacade(adapter, protect);
    const request = req();
    const ctx = {};
    const out = await facade.fetch(request, env, ctx as never);
    expect(seen).toEqual([adapter, request, env, ctx]);
    expect(seen[0]).toBe(adapter);
    expect(protect).toHaveBeenCalledTimes(1);
    expect(protect).toHaveBeenCalledWith(request, expect.any(Response), env);
    expect(await out.text()).toBe("ok");
  });

  it("runs other handlers with the adapter as receiver and keeps non-functions", () => {
    const adapter = {
      name: "adapter",
      scheduled(this: unknown, id: string) {
        return [this, id];
      },
      fetch: async () => new Response("x"),
    };
    const facade = createKitWorkerFacade(adapter, passthrough);
    const [receiver, id] = facade.scheduled("a") as [unknown, string];
    expect(receiver).toBe(adapter);
    expect(id).toBe("a");
    expect(facade.name).toBe("adapter");
    expect(Object.getPrototypeOf(facade)).toBe(Object.getPrototypeOf(adapter));
    expect(facade[KIT_WORKER_FACADE as never]).toBe(true);
  });

  it("wraps inherited fetch and binds inherited handlers and accessors", async () => {
    class Adapter {
      name = "adapter";
      get label() {
        return this === adapter ? this.name : "wrong";
      }
      scheduled() {
        return this;
      }
      async fetch(_request: Request, _env: typeof env) {
        return new Response(this.name);
      }
    }
    const adapter = new Adapter();
    const protect = vi.fn(passthrough);
    const facade = createKitWorkerFacade(adapter, protect);
    expect(facade.label).toBe("adapter");
    expect(facade.scheduled()).toBe(adapter);
    expect(await (await facade.fetch(req(), env)).text()).toBe("adapter");
    expect(protect).toHaveBeenCalledTimes(1);
  });

  it("does not consume or lock the returned stream", async () => {
    const response = new Response("streamed");
    const facade = createKitWorkerFacade(
      { fetch: async (..._args: unknown[]) => response },
      passthrough,
    );
    const out = await facade.fetch(req(), env);
    expect(out).toBe(response);
    expect(out.bodyUsed).toBe(false);
    expect(out.body?.locked).toBe(false);
  });

  it("propagates adapter and protector failures without a replay", async () => {
    const boom = new Error("boom");
    const fetch = vi.fn(async (..._args: unknown[]) => {
      throw boom;
    });
    const protect = vi.fn(passthrough);
    await expect(createKitWorkerFacade({ fetch }, protect).fetch(req(), env)).rejects.toBe(boom);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(protect).not.toHaveBeenCalled();
  });

  it("rejects bad requests, responses and env after at most one delegation", async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response("x"));
    const facade = createKitWorkerFacade({ fetch }, passthrough);
    await expect(facade.fetch({} as Request, env)).rejects.toThrow("must be a Request");
    expect(fetch).not.toHaveBeenCalled();
    await expect(facade.fetch(req(), {} as never)).rejects.toThrow("APP_URL");
    expect(fetch).toHaveBeenCalledTimes(1);
    const bad = createKitWorkerFacade(
      { fetch: async (..._args: unknown[]) => "no" as never },
      passthrough,
    );
    await expect(bad.fetch(req(), env)).rejects.toThrow("must return a Response");
  });

  it("rejects malformed and duplicate adapters", () => {
    for (const bad of [null, undefined, "x", () => 1, {}, { fetch: 1 }]) {
      expect(() => createKitWorkerFacade(bad as never, passthrough)).toThrow(TypeError);
    }
    const facade = createKitWorkerFacade({ fetch: async () => new Response("x") }, passthrough);
    expect(() => createKitWorkerFacade(facade, passthrough)).toThrow("already wrapped");
  });
});
