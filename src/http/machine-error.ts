import { alertRequestError } from "../alerts";
import {
  PUBLIC_DATA_ERROR_NEXT,
  PUBLIC_DATA_INTERNAL_MESSAGE,
  type PublicDataErrorDto,
} from "../public-data/contracts";
import { selectRequestId } from "./request-log";

/** Wrap public REST handlers only. Return expected refusals as responses, not throws. */
export function withMachineErrors<Event extends { request: Request }>(
  handler: (event: Event) => Response | Promise<Response>,
  {
    route,
    getRequestId,
  }: {
    /** A registered route pattern supplied by the adapter, never the request URL or path. */
    route: string;
    /** The adapter's existing correlation ID, if any. */
    getRequestId?: (event: Event) => unknown;
  },
): (event: Event) => Promise<Response> {
  return async (event) => {
    try {
      return await handler(event);
    } catch (err) {
      const requestId = selectRequestId(getRequestId?.(event));
      const context = { method: event.request.method, route, requestId };
      try {
        alertRequestError(err, context);
      } catch {
        // Even an uninspectable thrown value must produce the REST envelope.
        alertRequestError(new Error(), context);
      }
      const body: PublicDataErrorDto = {
        error: {
          code: "internal",
          message: PUBLIC_DATA_INTERNAL_MESSAGE,
          request_id: requestId,
          next: PUBLIC_DATA_ERROR_NEXT.internal,
        },
      };
      return Response.json(body, {
        status: 500,
        headers: { "cache-control": "no-store, private", "x-request-id": requestId },
      });
    }
  };
}
