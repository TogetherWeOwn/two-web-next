// Runtime for the installed Kit Worker response facade.
// Design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3
// (web/scripts/install-worker-facade.mjs and src/kit-worker-response.ts).
import { protectKitWorkerResponse } from "./kit-worker-response";

export const KIT_WORKER_FACADE = Symbol.for("two-web-next.kit-worker-facade");

// The installed facade and the hook are bundled separately. Share only
// in-flight slots keyed by the original Request, never by its URL or headers.
const honoDataKey = Symbol.for("two-web-next.kit-hono-data");
type HonoDataSlot = { result?: { original: Response; placeholder: Response } };
const scope = globalThis as typeof globalThis & {
  [honoDataKey]?: WeakMap<Request, HonoDataSlot>;
};
const honoDataSlots = (scope[honoDataKey] ??= new WeakMap<Request, HonoDataSlot>());

export function preserveHonoDataResponse(request: Request, original: Response): Response {
  const slot = honoDataSlots.get(request);
  if (!slot) return original; // Stock adapter or Vite dev, without the facade.

  // Kit can replace hook-returned redirects on data requests. Carry the raw
  // Hono response out of band so Kit neither serializes it nor reads its body.
  const placeholder = new Response(null, { status: 204 });
  slot.result = { original, placeholder };
  return placeholder;
}

type Env = { APP_URL: string; FEATURED_IMAGE_HOSTS?: string };
export type KitWorkerProtector = (
  request: Request,
  response: Response,
  env: Env,
) => Promise<Response>;
type Fn = (...args: unknown[]) => unknown;
type Facade<T> = {
  [K in keyof T]: K extends "fetch"
    ? T[K] extends (...args: infer A) => unknown
      ? (...args: A) => Promise<Response>
      : T[K]
    : OmitThisParameter<T[K]>;
};

// Wraps a generated adapter default export. Own properties and the prototype are
// copied as written. Every function handler, fetch included, runs with the real
// adapter as receiver and unchanged arguments, so the adapter never sees the
// facade. Only fetch's returned Response is protected, except for a completed
// Hono handoff. Accessors use the adapter as receiver. The adapter is delegated
// to exactly once per call, and a rejection propagates without a replay.
export function createKitWorkerFacade<T extends object>(
  adapter: T,
  protect: KitWorkerProtector = protectKitWorkerResponse,
  intercept?: (request: Request, env: Env) => Promise<Response | null>,
): Facade<T> {
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
    if (descriptor.get) {
      const get = descriptor.get;
      descriptor.get = () => {
        const value: unknown = Reflect.apply(get, adapter, []);
        return typeof value === "function" ? value.bind(adapter) : value;
      };
    }
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
      // Bound machine routes (and future upgrades) must not enter Kit or have
      // their responses reconstructed by the document response protector.
      const intercepted = intercept && (await intercept(request, env as Env));
      if (intercepted) return intercepted;
      const slot: HonoDataSlot = {};
      honoDataSlots.set(request, slot);
      try {
        const response = await Reflect.apply(fetchHandler, adapter, args);
        if (!(response instanceof Response))
          throw new TypeError("kit worker facade: adapter must return a Response");
        const appUrl = (env as { APP_URL?: unknown } | null | undefined)?.APP_URL;
        if (typeof appUrl !== "string")
          throw new TypeError("kit worker facade: env.APP_URL is required");

        // A Kit error or asset response never matches the placeholder.
        if (slot.result?.placeholder === response) return slot.result.original;
        return protect(request, response, env as Env);
      } finally {
        if (honoDataSlots.get(request) === slot) honoDataSlots.delete(request);
      }
    },
  };
  descriptors[KIT_WORKER_FACADE as unknown as string] = { value: true };
  return Object.create(Object.getPrototypeOf(adapter), descriptors) as Facade<T>;
}
