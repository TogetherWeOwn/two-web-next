// Inactive runtime for the Kit Worker response facade. Nothing imports this
// module yet: no installer, Vite or Wrangler wiring activates it.
// Design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3
// (web/scripts/install-worker-facade.mjs and src/kit-worker-response.ts).
import { protectKitWorkerResponse } from "./kit-worker-response";

export const KIT_WORKER_FACADE = Symbol.for("two-web-next.kit-worker-facade");

type Env = { APP_URL: string; FEATURED_IMAGE_HOSTS?: string };
export type KitWorkerProtector = (
  request: Request,
  response: Response,
  env: Env,
) => Promise<Response>;
type Fn = (...args: unknown[]) => unknown;

// Wraps a generated adapter default export. Own properties and the prototype are
// copied as written. Every function handler, fetch included, runs with the real
// adapter as receiver and unchanged arguments, so the adapter never sees the
// facade. Only fetch's returned Response is protected. Accessors use the adapter
// as receiver. The adapter is delegated to exactly once per call, a rejection
// propagates without a replay, and the response body is never read here.
export function createKitWorkerFacade<T extends object>(
  adapter: T,
  protect: KitWorkerProtector = protectKitWorkerResponse,
): T {
  if (adapter === null || typeof adapter !== "object") {
    throw new TypeError("kit worker facade: adapter must be an object");
  }
  const fetchHandler = (adapter as { fetch?: unknown }).fetch;
  if (typeof fetchHandler !== "function") {
    throw new TypeError("kit worker facade: adapter must have a fetch function");
  }
  if (KIT_WORKER_FACADE in adapter) {
    throw new TypeError("kit worker facade: adapter is already wrapped");
  }

  const descriptors = Object.getOwnPropertyDescriptors(adapter) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  for (
    let proto = Object.getPrototypeOf(adapter);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Reflect.ownKeys(proto)) {
      if (key !== "constructor" && !Object.hasOwn(descriptors, key)) {
        descriptors[key as string] = Object.getOwnPropertyDescriptor(proto, key)!;
      }
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string]!;
    if (descriptor.get) descriptor.get = descriptor.get.bind(adapter);
    if (descriptor.set) descriptor.set = descriptor.set.bind(adapter);
    if (key === "fetch" || typeof descriptor.value !== "function") continue;
    const handler = descriptor.value as Fn;
    descriptor.value = function (...args: unknown[]) {
      return Reflect.apply(handler, adapter, args);
    };
  }
  descriptors.fetch = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: async function fetch(...args: unknown[]): Promise<Response> {
      const [request, env] = args;
      if (!(request instanceof Request))
        throw new TypeError("kit worker facade: request must be a Request");
      const response = await Reflect.apply(fetchHandler, adapter, args);
      if (!(response instanceof Response))
        throw new TypeError("kit worker facade: adapter must return a Response");
      const appUrl = (env as { APP_URL?: unknown } | null | undefined)?.APP_URL;
      if (typeof appUrl !== "string")
        throw new TypeError("kit worker facade: env.APP_URL is required");
      return protect(request, response, env as Env);
    },
  };
  descriptors[KIT_WORKER_FACADE as unknown as string] = { value: true };
  return Object.create(Object.getPrototypeOf(adapter), descriptors) as T;
}
