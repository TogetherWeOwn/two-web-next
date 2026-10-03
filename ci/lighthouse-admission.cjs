// Do not announce LHCI readiness until the actual local worker has populated SSR.
// A 200 homepage fallback is not an admissible performance measurement.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const origin = "http://127.0.0.1:8787";
const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const paths = ["/", "/events", `/e/${key}`, "/join", "/about"];
const readyPattern = "Lighthouse fixture content admitted";

function assertFixtureContent(path, response, html, before, after) {
  assert.equal(response.status, 200, `${path}: fixture status`);
  assert.equal(response.redirected, false, `${path}: fixture redirect`);
  assert.match(response.headers.get("content-type") || "", /text\/html/, `${path}: HTML required`);
  assert.match(html, /<link\b[^>]*href="\/styles\.css"/, `${path}: real app stylesheet`);
  let populated;
  if (path === "/") {
    assert.doesNotMatch(
      html,
      /data-testid="home-events-empty"|data-state="unavailable"/,
      "Homepage fallback is not admissible",
    );
    populated = html.match(/<ul\b[^>]*data-testid="home-events-list"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
    assert.ok(populated, "Homepage populated teaser required");
    assert.match(populated, new RegExp(`href="/e/${key}"`), "Homepage fixture link");
    assert.match(populated, /3 going/, "Homepage aggregate required");
    const featured = html.match(
      /<section\b[^>]*data-testid="featured-content"[^>]*>([\s\S]*?)<\/section>/,
    )?.[1];
    assert.ok(
      featured?.includes("Lighthouse fixture community news"),
      "Homepage featured fixture required",
    );
  } else if (path === "/events") {
    assert.doesNotMatch(
      html,
      /data-testid="events-empty-(never|gap|error|search)"/,
      "Empty calendar is not admissible",
    );
    populated = html.match(
      /<article\b[^>]*data-event-key="01ARZ3NDEKTSV4RRFFQ69G5FAV"[^>]*data-testid="event-card"[^>]*>([\s\S]*?)<\/article>/,
    )?.[1];
    assert.ok(populated, "Calendar populated fixture card required");
    assert.match(
      populated,
      /data-testid="event-going-count">3 of 20 going/,
      "Calendar aggregate required",
    );
  } else if (path === `/e/${key}`) {
    populated = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    assert.ok(populated, "Event detail main content required");
    assert.match(
      populated,
      /<h1\b[^>]*>Lighthouse fixture game night<\/h1>/,
      "Event detail fixture heading",
    );
    assert.match(
      populated,
      /data-testid="event-going-count"[\s\S]*?<span data-count>3 of 20 going/,
      "Event detail aggregate required",
    );
    assert.match(
      populated,
      /A local-only community game night used to measure the real event page\./,
      "Event detail description required",
    );
    assert.match(populated, /data-testid="event-join-pitch"/, "Anonymous detail fixture required");
  } else {
    assert.ok(paths.includes(path), "Unknown fixture path");
    assert.match(
      html,
      path === "/join"
        ? /<h1\b[^>]*>Join Together We Own<\/h1>/
        : /<h1\b[^>]*>About Together We Own<\/h1>/,
      `${path}: real page heading`,
    );
    if (path === "/join") assert.doesNotMatch(html, /<iframe\b/, "Fixture must not embed Discord");
  }
  if (populated) {
    assert.ok(
      populated.includes("Lighthouse fixture game night"),
      `${path}: fixture title in rendered content`,
    );
    assert.ok(
      populated.includes("Community voice channel"),
      `${path}: fixture venue in rendered content`,
    );
    const times = [...populated.matchAll(/<time\b[^>]*datetime="([^"]+)"/g)];
    assert.ok(times.length > 0, `${path}: rendered fixture time required`);
    for (const [, instant] of times) {
      const startsAt = Date.parse(instant);
      assert.ok(
        startsAt >= before + 7 * 86400_000 && startsAt <= after + 7 * 86400_000,
        `${path}: fixture must start seven days after this local request, not at workerd's module epoch`,
      );
    }
  }
}

async function probeFixture(urls, fetchPage = fetch) {
  // Validate the ENTIRE set before the first fetch, including redirects below.
  assert.deepEqual(
    urls,
    paths.map((path) => `${origin}${path}`),
    "Only the five local fixture URLs may be probed",
  );
  for (const url of urls) {
    const before = Date.now();
    const response = await fetchPage(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    assertFixtureContent(new URL(url).pathname, response, html, before, Date.now());
  }
}

function startFixture(
  urls,
  {
    spawnServer = () =>
      spawn("npm", ["run", "dev:lighthouse"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        },
      }),
    fetchPage = fetch,
    output = process.stdout,
    errors = process.stderr,
    stopServer = (child) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    },
  } = {},
) {
  const child = spawnServer();
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      stopServer(child);
    }
  };
  let checking = false;
  let admitted = false;
  let exited = false;
  let startup = "";
  let deadline;
  const admission = new Promise((resolve, reject) => {
    // LHCI only warns and proceeds when its unchanged 60s readiness wait expires.
    // Exit before that permissive fallback; this is a stricter local admission
    // watchdog, not an extension of the collection/startup timeout.
    deadline = setTimeout(
      () => reject(new Error("Local Lighthouse content admission exceeded 55s")),
      55000,
    );
    const onOutput = (destination, chunk) => {
      destination.write(chunk);
      startup = (startup + chunk).slice(-8192);
      if (!stopped && !checking && /Ready on http:\/\/127\.0\.0\.1:8787/.test(startup)) {
        checking = true;
        probeFixture(urls, fetchPage).then(() => {
          if (exited || stopped) return; // Never publish late readiness after shutdown/failure.
          clearTimeout(deadline);
          admitted = true;
          output.write(`${readyPattern}\n`);
          resolve();
        }, reject);
      }
    };
    child.stdout.on("data", (chunk) => onOutput(output, chunk));
    child.stderr.on("data", (chunk) => onOutput(errors, chunk));
    child.once("error", (error) => {
      exited = true;
      reject(error);
    });
    child.once("exit", () => {
      exited = true;
      if (!admitted) reject(new Error("Local Lighthouse server exited before content admission"));
    });
  }).catch((error) => {
    clearTimeout(deadline);
    stop();
    throw error;
  });
  return { child, admission, stop };
}

module.exports = { assertFixtureContent, probeFixture, startFixture, readyPattern };

if (require.main === module) {
  const { child, admission, stop } = startFixture(require("./lighthouserc.cjs").ci.collect.url);
  // Wrangler's fixed port must not survive LHCI shutdown or an admission failure.
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stop);
  child.once("exit", (code) => {
    process.exitCode = process.exitCode || code || 0;
  });
  admission.catch((error) => {
    console.error(`Lighthouse fixture content admission failed: ${error.message}`);
    stop();
    // A still-pending probe must not keep us alive until LHCI's warn-and-continue
    // readiness timeout. All owned descendants have received shutdown first.
    process.exit(1);
  });
}
