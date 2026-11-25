import type { Ctx } from "../events/routes-shared";
import { HotzoneBadSeasonPage, HotzoneSignalNotFoundPage } from "./pages";

export function refuseHotzone(c: Ctx, status: 400 | 404): Response | Promise<Response> {
  c.header("cache-control", "no-store, private");
  if (c.req.method === "HEAD") {
    return c.body(null, status, { "content-type": "text/html; charset=UTF-8" });
  }
  return c.html(status === 400 ? <HotzoneBadSeasonPage /> : <HotzoneSignalNotFoundPage />, status);
}
