// Offline job plans. The existing staging lane encloses the whole plan,
// including the reservation read. A future reservation writer must use
// that lane too. Each check reads the same reservation when the job starts,
// after any queue wait. These plans assume existing workflow admission passed.
export const stagingLane = {
  group: "deploy-staging",
  "cancel-in-progress": false,
  queue: "max",
};

export const stagingPlans = {
  // deploy.yml / deploy-staging: check from the workflow revision before
  // applying staging migrations, the first remote mutation.
  deploy: ["check-mutation", "apply-migrations", "replace-allocation"],

  // rollback-production.yml: check inside the standalone staging rollback job
  // after it acquires deploy-staging. The run-specific drill legs inherit the
  // plan's admission. The reservation coordinates cooperating workflows;
  // the future integration owns the staging dispatch ref trust boundary.
  rollback: ["check-mutation", "rollback-worker"],

  // staging-rollback-drill.yml: the caller holds the lane across plan,
  // rollback and restore. Put the check in plan so both legs depend on
  // admission, and keep the existing run-specific groups in the callee.
  drill: ["check-mutation", "record-versions", "rollback-worker", "restore-worker"],

  // e2e-staging.yml: in the same lane, use the workflow revision to
  // check the pinned candidate and live allocation before executing journeys.
  e2e: ["observe-allocation", "check-e2e", "run-journeys"],
};
