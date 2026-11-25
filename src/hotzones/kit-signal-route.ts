import { tryDecodeURIComponent } from "hono/utils/url";
import { isHotzoneSignal } from "./aggregates";

const singleSignalSegment = /^\/hotzones\/([^/]+)$/;

export const KIT_HOTZONE_SIGNAL_ROUTE = {
  method: "GET",
  path: "/hotzones/:signal",
  enabled: true,
  reads: "public",
  dynamic: {
    id: "/hotzones/[signal]",
    matches: (_raw: string, decoded: string) => {
      const segment = singleSignalSegment.exec(decoded)?.[1];
      // Match Hono's param decoding after the router's pathname decoding.
      // Only the existing exact manifest entries can serve a known signal.
      return segment !== undefined && !isHotzoneSignal(tryDecodeURIComponent(segment));
    },
  },
} as const;
