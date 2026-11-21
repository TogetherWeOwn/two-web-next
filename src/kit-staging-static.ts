// Set one entry to false to return just that document to Hono on staging.
export const STAGING_STATIC_DOCUMENT_READY: ReadonlyMap<string, boolean> = new Map([
  ["/privacy", true],
  ["/rules", true],
]);
