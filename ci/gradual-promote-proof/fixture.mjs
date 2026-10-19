// Synthetic no-data Worker fixture for the gradual-promotion proof harness.
//
// This file is the entire Worker. It has no imports and reads only three
// bindings supplied by the generated proof config: CF_VERSION_METADATA
// (version attribution), PROOF_MODE ("ok" or "fail-up") and PROOF_LABEL.
// There is deliberately no database, queue, service, asset or secret
// binding: proof-lib.mjs refuses to generate a config that adds one.
//
// The route table satisfies the real deploy smoke checker (bin/smoke.mjs,
// 23 GETs) so the pinned gradual-promote action runs its genuine gates
// against this fixture instead of the live site. The fail-up mode makes
// /up answer 503 with a down envelope, which is a real health failure the
// checker rejects on status and body shape.
//
// Every response carries x-proof-version-id / x-proof-version-tag /
// x-proof-label / x-proof-mode from the version-metadata binding and the
// per-version vars, so a probe can prove which uploaded version served it
// rather than inferring attribution from a bare HTTP 200.

const HTML_PAGES = {
  "/": "<h1>The lobby is open.</h1><p>Synthetic gradual-promotion proof fixture.</p>",
  "/about": "<h1>About Together We Own</h1><p>Synthetic proof fixture page.</p>",
  "/faq": "<h1>Frequently asked questions</h1><p>Synthetic proof fixture page.</p>",
  "/rules": '<h1 id="rules-heading">House rules</h1><p>Synthetic proof fixture page.</p>',
  "/privacy": "<h1>Privacy policy</h1><p>Synthetic proof fixture page.</p>",
  "/events": '<h1 id="events-heading">Events</h1><p>Synthetic proof fixture page.</p>',
  "/events/past":
    '<h1 id="past-events-heading">Past events</h1><p>Synthetic proof fixture page.</p>',
  "/join": "<h1>Join Together We Own</h1><p>One click with Discord</p>",
};

function proofHeaders(env, extra = {}) {
  const metadata = env?.CF_VERSION_METADATA ?? {};
  return {
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "x-proof-version-id": typeof metadata.id === "string" ? metadata.id : "unbound",
    "x-proof-version-tag": typeof metadata.tag === "string" ? metadata.tag : "untagged",
    "x-proof-label": typeof env?.PROOF_LABEL === "string" ? env.PROOF_LABEL : "unlabelled",
    "x-proof-mode": env?.PROOF_MODE === "fail-up" ? "fail-up" : "ok",
    ...extra,
  };
}

function html(env, status, body) {
  return new Response(`<!doctype html><html lang="en"><body>${body}</body></html>`, {
    status,
    headers: proofHeaders(env, {
      "content-type": "text/html; charset=UTF-8",
      "x-robots-tag": "noindex, nofollow",
    }),
  });
}

export function handleProofRequest(request, env = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const failUp = env?.PROOF_MODE === "fail-up";

  if (path === "/up") {
    const metadata = env?.CF_VERSION_METADATA ?? {};
    const body = failUp
      ? { status: "down", db: "down", pending_migrations: 0 }
      : {
          status: "healthy",
          db: "ok",
          pending_migrations: 0,
          queue: { status: "unknown", warn_at: 20, critical_at: 100 },
        };
    return new Response(
      JSON.stringify({
        ...body,
        // Top-level revision mirrors src/up-revision.ts so the real smoke
        // checker can attribute an overridden probe to this exact version.
        // commit is null: proof tags are not deploy SHAs.
        revision: {
          version_id: typeof metadata.id === "string" ? metadata.id : null,
          commit: null,
        },
        proof: {
          version_id: typeof metadata.id === "string" ? metadata.id : null,
          version_tag: typeof metadata.tag === "string" ? metadata.tag : null,
          label: typeof env?.PROOF_LABEL === "string" ? env.PROOF_LABEL : null,
          mode: failUp ? "fail-up" : "ok",
        },
      }),
      {
        status: failUp ? 503 : 200,
        headers: proofHeaders(env, {
          "content-type": "application/json; charset=UTF-8",
          "x-two-origin": "two-web-next",
          "cache-control": "no-store",
        }),
      },
    );
  }

  if (Object.hasOwn(HTML_PAGES, path)) return html(env, 200, HTML_PAGES[path]);

  if (path === "/events.rss") {
    return new Response(
      '<rss version="2.0"><channel><title>Proof fixture</title></channel></rss>',
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "application/rss+xml; charset=UTF-8" }),
      },
    );
  }

  if (path === "/events.ics") {
    return new Response(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//proof-fixture//EN\r\nEND:VCALENDAR\r\n",
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "text/calendar; charset=UTF-8" }),
      },
    );
  }

  if (path === "/sitemap_index.xml") {
    const locs = Object.keys(HTML_PAGES)
      .map((page) => `<url><loc>${url.origin}${page}</loc></url>`)
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`,
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "application/xml; charset=UTF-8" }),
      },
    );
  }

  if (path === "/robots.txt") {
    return new Response(`User-agent: *\nDisallow:\nSitemap: ${url.origin}/sitemap_index.xml\n`, {
      status: 200,
      headers: proofHeaders(env, { "content-type": "text/plain; charset=UTF-8" }),
    });
  }

  // RFC 9116 publication, mirroring buildSecurityTxt in src/security-txt.ts.
  // The Expires pin must match SMOKE_SECURITY_TXT_EXPIRES in bin/smoke.mjs
  // (currently 2027-10-01T00:00:00Z). Canonical is https-only (RFC 9116
  // §2.5.2): the http loopback harness serves and asserts no Canonical line,
  // while an https probe serves and asserts the same-origin value.
  if (path === "/.well-known/security.txt") {
    const canonical =
      url.protocol === "https:" ? `Canonical: ${url.origin}/.well-known/security.txt\n` : "";
    return new Response(
      `Contact: https://github.com/TogetherWeOwn/two-web-next/security/advisories/new\nExpires: 2027-10-01T00:00:00Z\nPreferred-Languages: en\n${canonical}Policy: https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md\n`,
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "text/plain; charset=UTF-8" }),
      },
    );
  }

  // Shape-only redirect targets: the smoke checker uses redirect: "manual"
  // and never follows either Location, so the fixture invite need not exist.
  if (path === "/discord") {
    return new Response(null, {
      status: 302,
      headers: proofHeaders(env, { location: "https://discord.gg/proof-fixture" }),
    });
  }

  if (path === "/profile" || path === "/admin") {
    return new Response(null, {
      status: 302,
      headers: proofHeaders(env, { location: "/auth/discord" }),
    });
  }

  // Session-free public read API: collection envelope, one missing event
  // (404 not_found), community snapshot, join handoff, and discovery
  // document, mirroring the healthy fixtures in test/smoke.test.mjs. The
  // real checker asserts each envelope shape and the OpenAPI marker, not
  // fixture contents.
  if (path === "/api/public/events") {
    return new Response(
      '{"data":[],"page":1,"limit":20,"meta":{"current_page":1,"per_page":20,"total":0,"last_page":1}}',
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "application/json; charset=UTF-8" }),
      },
    );
  }

  // The fixed probe key exists in no database: 404 not_found like the
  // real handler (src/public-data/routes.ts).
  if (path === "/api/public/events/00000000000000000000000001") {
    return new Response(
      '{"error":{"code":"not_found","message":"No published event with that key."}}',
      {
        status: 404,
        headers: proofHeaders(env, { "content-type": "application/json; charset=UTF-8" }),
      },
    );
  }

  if (path === "/api/public/community") {
    return new Response(
      '{"member_count":123,"online_count":12,"ranks":[{"key":"veterans","label":"Veterans","member_count":42}]}',
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "application/json; charset=UTF-8" }),
      },
    );
  }

  if (path === "/api/public/join") {
    return new Response(
      '{"intro":"Approve once with Discord and we will add you to the server.","invite_url":"https://discord.gg/fixture"}',
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "application/json; charset=UTF-8" }),
      },
    );
  }

  if (path === "/openapi.json") {
    return new Response(
      '{"openapi":"3.1.0","info":{"title":"Together We Own public read API","version":"1.0.0"},"paths":{"/api/public/events":{"get":{"responses":{"200":{"description":"ok"}}}}}}',
      {
        status: 200,
        headers: proofHeaders(env, { "content-type": "application/json; charset=UTF-8" }),
      },
    );
  }

  return html(
    env,
    404,
    "<title>We cannot find that page — Together We Own</title><h1>Not found</h1>",
  );
}

export default {
  fetch(request, env) {
    return handleProofRequest(request, env);
  },
};
