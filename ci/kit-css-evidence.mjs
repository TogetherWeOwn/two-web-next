const NODE_KEY = /^\.svelte-kit\/generated\/build\/client-optimized\/nodes\/\d+\.js$/;

/**
 * CSS files reachable from a route's page nodes (leaf, layouts, errors) in the
 * client manifest. Static imports always count; dynamic imports only with
 * `dynamic: true`. The shared router bootstrap is excluded so a hit proves the
 * route's own graph reached the stylesheet. Returns sorted manifest paths such
 * as `_app/immutable/assets/0.abc.css`.
 */
export function routeCssFiles(manifest, routeEvidence, routeId, { dynamic = false } = {}) {
  const route = routeEvidence.routes?.find((r) => r.id === routeId);
  if (!route) throw new Error(`Unknown route in build evidence: ${routeId}`);
  if (!route.page) throw new Error(`Route has no page: ${routeId}`);
  const byIndex = new Map();
  for (const key of Object.keys(manifest)) {
    if (!NODE_KEY.test(key)) continue;
    byIndex.set(Number(key.match(/(\d+)\.js$/)[1]), key);
  }
  const starts = [route.page.leaf, ...route.page.layouts, ...route.page.errors]
    .filter((n) => n !== null && n !== undefined)
    .map((n) => {
      const key = byIndex.get(n);
      if (!key) throw new Error(`Missing client node ${n} for route ${routeId}`);
      return key;
    });
  const seen = new Set();
  const css = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Manifest references missing chunk: ${key}`);
    for (const file of chunk.css ?? []) css.add(file);
    for (const dep of chunk.imports ?? []) visit(dep);
    if (dynamic) for (const dep of chunk.dynamicImports ?? []) visit(dep);
  };
  for (const key of starts) visit(key);
  return [...css].sort();
}

/** Builds the evidence object handed to callers; pure over its inputs. */
export function createEvidence({ root, output, client, server, manifest, routeEvidence }) {
  const matches = (text, needle) =>
    needle instanceof RegExp
      ? new RegExp(needle.source, needle.flags).test(text)
      : text.includes(needle);
  const textOf = new Map(client.map((f) => [f.file, f.text]));
  const routeCss = (routeId, options) => routeCssFiles(manifest, routeEvidence, routeId, options);
  return {
    root,
    output,
    manifest,
    routeEvidence,
    clientCss: client,
    serverCss: server,
    /** Client CSS file paths whose text includes `needle` (string or RegExp). */
    cssContaining: (needle) => client.filter((f) => matches(f.text, needle)).map((f) => f.file),
    cssText: (file) => {
      if (!textOf.has(file)) throw new Error(`No compiled client CSS: ${file}`);
      return textOf.get(file);
    },
    routeCss,
    /** True when a CSS file in the route's graph contains `needle`. */
    routeCssContains: (routeId, needle, options) =>
      routeCss(routeId, options).some((file) => {
        const text = textOf.get(file) ?? "";
        return matches(text, needle);
      }),
  };
}
