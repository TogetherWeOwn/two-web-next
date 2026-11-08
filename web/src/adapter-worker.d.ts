// The adapter entry exists only after the build; svelte-check runs before it.
// Describe the fetch surface used by the production response boundary without
// replacing, generating or executing the adapter output during typechecking.
declare module "*/.svelte-kit/cloudflare/_worker.js" {
  const worker: {
    fetch(request: Request, env: Cloudflare.Env): Promise<Response>;
  };
  export default worker;
}
