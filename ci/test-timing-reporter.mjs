import { performance } from "node:perf_hooks";

// Public Vitest reporter hooks; hook-delivery times are deliberately not used.
// Source: https://vitest.dev/api/advanced/reporters.html
export default class TestTimingReporter {
  start = performance.now();
  lastModuleEnd;
  coverageReady;

  emit(event, fields = {}) {
    try {
      console.log(`TWO_TEST_TIMING ${JSON.stringify({
        kind: "vitest", event, atMs: performance.now() - this.start, ...fields,
      })}`);
    } catch {}
  }

  onTestRunStart(specifications) {
    this.emit("run-start", { files: specifications.length });
  }

  onTestModuleEnd(module) {
    const d = module.diagnostic();
    this.lastModuleEnd = performance.now();
    this.emit("module-end", { file: module.relativeModuleId, state: module.state(),
      collectMs: d.collectDuration, testsAndHooksMs: d.duration,
      prepareMs: d.prepareDuration, environmentSetupMs: d.environmentSetupDuration,
      setupMs: d.setupDuration,
    });
  }

  onCoverage() {
    this.coverageReady = performance.now();
    this.emit("coverage-ready", { lastModuleToCoverageReadyMs:
      this.lastModuleEnd === undefined ? null : this.coverageReady - this.lastModuleEnd,
    });
  }

  onTestRunEnd(modules, errors, reason) {
    this.emit("run-end", { files: modules.length, errorCount: errors.length, reason,
      coverageReadyToRunEndMs: this.coverageReady === undefined ? null : performance.now() - this.coverageReady,
    });
  }
}
