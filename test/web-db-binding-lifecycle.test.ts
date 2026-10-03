import { describe, expect, it, vi } from "vitest";
import { RequestClients } from "./helpers/request-clients";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const client = () => {
  let ended = false;
  return {
    end: vi.fn(async () => {
      ended = true;
    }),
    query: () => {
      if (ended) throw new Error("CONNECTION_ENDED");
      return "connected";
    },
  };
};

describe("web DB binding request lifecycle", () => {
  it("a late request cannot end clients belonging to the next request", async () => {
    const clients = new RequestClients();
    const firstDone = deferred();
    const secondDone = deferred();
    const firstClient = client();
    const lateClient = client();
    const secondClient = client();
    const first = clients.run(async () => {
      clients.track(firstClient);
      await firstDone.promise;
      // A factory may create another client after an awaited DB operation.
      clients.track(lateClient);
      return firstClient.query();
    });
    const second = clients.run(async () => {
      clients.track(secondClient);
      await secondDone.promise;
      return secondClient.query();
    });
    try {
      // Model a timed-out caller moving on before its request has settled.
      firstDone.resolve();
      expect(await first).toBe("connected");
      expect(firstClient.end).toHaveBeenCalledTimes(1);
      expect(lateClient.end).toHaveBeenCalledTimes(1);
      expect(secondClient.end).not.toHaveBeenCalled();
      expect(secondClient.query()).toBe("connected");
    } finally {
      secondDone.resolve();
      await second;
    }
    expect(secondClient.end).toHaveBeenCalledTimes(1);
  });

  it("closes owned clients when the request fails, without swallowing the failure", async () => {
    const clients = new RequestClients();
    const owned = client();
    await expect(
      clients.run(async () => {
        clients.track(owned);
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    await clients.drain();
    expect(owned.end).toHaveBeenCalledTimes(1);
  });

  it("drains late requests and their cleanup before fixture disposal", async () => {
    const clients = new RequestClients();
    const requestDone = deferred();
    const cleanupDone = deferred();
    const cleanupStarted = deferred();
    const dispose = vi.fn();
    const request = clients.run(async () => {
      clients.track({
        end: async () => {
          cleanupStarted.resolve();
          await cleanupDone.promise;
        },
      });
      await requestDone.promise;
    });
    const teardown = clients.drain().then(dispose);
    expect(dispose).not.toHaveBeenCalled();
    requestDone.resolve();
    await cleanupStarted.promise;
    expect(dispose).not.toHaveBeenCalled();
    cleanupDone.resolve();
    await request;
    await teardown;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses to take ownership of fixture clients outside a request", () => {
    const clients = new RequestClients();
    const fixtureClient = client();
    expect(() => clients.track(fixtureClient)).toThrow("outside an owned request");
    expect(fixtureClient.end).not.toHaveBeenCalled();
  });
});
