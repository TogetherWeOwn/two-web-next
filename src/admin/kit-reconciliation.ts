import { alertRequestError } from "../alerts";

/** Withhold the entire page model if the read or its receipt fails. */
export async function readKitReconciliation<T>(
  read: () => Promise<T>,
  route: "/admin/reconciliation" | "/admin/reconciliation/:key",
  requestId: string | undefined,
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    alertRequestError(err, { method: "GET", route, requestId });
    return null;
  }
}
