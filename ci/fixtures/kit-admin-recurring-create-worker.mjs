import { AsyncLocalStorage } from "node:async_hooks";
import { withEnv } from "cloudflare:workers";

const ownerHeader = "x-fixture-recurring-create-owner";
const dispatchHeader = "x-fixture-recurring-create-dispatches";

export function withRecurringCreateProbe(worker) {
  const recurringCreate = new AsyncLocalStorage();
  const transport = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rejectSend = recurringCreate.getStore();
    if (rejectSend) return rejectSend();
    return transport(input, init);
  };

  return {
    ...worker,
    async fetch(request, bindings, context) {
      const owner = request.headers.get(ownerHeader);
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/admin/events" ||
        (owner !== "kit" && owner !== "hono")
      ) {
        return worker.fetch(request, bindings, context);
      }

      let sends = 0;
      async function rejectSend() {
        sends++;
        throw new Error("Unexpected outbound recurring draft dispatch");
      }
      const queue = { send: rejectSend, sendBatch: rejectSend };
      const fixture = {
        ...bindings,
        KIT_ROUTE_ADMIN: owner === "kit" ? "true" : "false",
        SYNC_EVENT_QUEUE: queue,
        INTERNAL_ACTION_QUEUE: queue,
        BOT_ENDPOINT_URL: "https://fixture-recurring-create.invalid",
        BOT_KEY_ID: "fixture-recurring-create",
        BOT_SHARED_SECRET: "synthetic-recurring-create-fixture",
      };
      const form = new Request(request);
      form.headers.delete(ownerHeader);
      const response = await recurringCreate.run(rejectSend, () =>
        withEnv(fixture, () => worker.fetch(form, fixture, context)),
      );
      const headers = new Headers(response.headers);
      headers.set(dispatchHeader, String(sends));
      return new Response(response.body, { status: response.status, headers });
    },
  };
}
