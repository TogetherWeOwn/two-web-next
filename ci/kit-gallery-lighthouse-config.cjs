// LHCI configuration for the already-running, isolated component gallery.
// Preserve the repository's profiles and assertions; only replace the target
// and omit server startup because the gallery launcher owns that lifecycle.
const { ci: mobile } = require("./lighthouserc.cjs");

function galleryConfig(mode, target) {
  if (process.env.QUALITY_ORIGIN)
    throw new Error("QUALITY_ORIGIN is not valid for the local gallery");
  const { ci: desktop } = require("./lighthouserc.quality.cjs");
  if (mode !== "mobile" && mode !== "desktop")
    throw new Error("gallery Lighthouse mode must be mobile or desktop");
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new Error("invalid gallery Lighthouse URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "gallery Lighthouse URL must be an uncredentialed loopback HTTP URL without a fragment",
    );
  }
  const base = mode === "mobile" ? mobile : desktop;
  const collect = structuredClone(base.collect);
  delete collect.startServerCommand;
  delete collect.startServerReadyPattern;
  delete collect.startServerReadyTimeout;
  collect.url = [url.href];
  return { ci: { collect, assert: structuredClone(base.assert) } };
}

module.exports = { galleryConfig };
