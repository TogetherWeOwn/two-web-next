import { AsyncLocalStorage } from "node:async_hooks";

type Client = { end: () => Promise<void> };

// A timed-out test can leave its request running while the next test starts.
// Cleanup must only end the clients created by that request's async context.
export class RequestClients {
  private readonly owners = new AsyncLocalStorage<Client[]>();
  private readonly pending = new Set<Promise<unknown>>();

  track(client: Client): void {
    const clients = this.owners.getStore();
    if (!clients) throw new Error("Runtime client created outside an owned request");
    clients.push(client);
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const clients: Client[] = [];
    const request = this.owners.run(clients, async () => {
      try {
        return await work();
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
    });
    this.pending.add(request);
    const release = () => { this.pending.delete(request); };
    void request.then(release, release);
    return request;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
