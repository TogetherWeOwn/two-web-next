// Validate metadata only; this does not connect to the database or authorize migrations.
// The caller must obtain serviceId from the Actions job context and inspect that
// exact container on the dedicated hosted runner, not from an untrusted input.
export function validateGalleryDatabaseIdentity({ serviceId, port, databaseUrl, inspect }) {
  if (!/^[a-f0-9]{64}$/.test(serviceId ?? "")) throw new Error("invalid service container id");
  if (!/^[1-9][0-9]{0,4}$/.test(port ?? "") || Number(port) > 65535) {
    throw new Error("invalid service port");
  }
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("invalid database URL");
  }
  if (
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== port ||
    url.username !== "postgres" ||
    url.password !== "ci" ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  )
    throw new Error("database URL does not match the service endpoint");
  if (!Array.isArray(inspect) || inspect.length !== 1)
    throw new Error("invalid container inspection");
  const container = inspect[0];
  const bindings = container?.NetworkSettings?.Ports?.["5432/tcp"];
  if (
    container?.Id !== serviceId ||
    container?.State?.Running !== true ||
    container?.Config?.Image !== "postgres:17" ||
    !Array.isArray(bindings) ||
    bindings.filter((binding) => ["0.0.0.0", "127.0.0.1"].includes(binding?.HostIp)).length !== 1 ||
    bindings.filter((binding) => binding?.HostIp === "::").length > 1 ||
    bindings.some(
      (binding) =>
        binding?.HostPort !== port || !["0.0.0.0", "127.0.0.1", "::"].includes(binding?.HostIp),
    )
  )
    throw new Error("container metadata does not match the service endpoint");
  return true;
}
