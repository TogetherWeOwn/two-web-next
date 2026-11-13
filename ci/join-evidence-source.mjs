import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

function inspectCheckout(directory) {
  if (!isAbsolute(directory)) throw new Error("checkout path must be absolute");
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        LC_ALL: "C",
      },
    }).trim();
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(directory)) {
    throw new Error("checkout path must be a worktree root");
  }
  return {
    sha: git("rev-parse", "--verify", "HEAD^{commit}"),
    clean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
  };
}

export function collectSourceIdentities(applicationRoot, controllerRoot) {
  const application = inspectCheckout(applicationRoot);
  const controller = inspectCheckout(controllerRoot);
  return {
    application: application.sha,
    applicationClean: application.clean,
    controller: controller.sha,
    controllerClean: controller.clean,
  };
}
