// lhci config for the production cutover watch: the budgets and mobile profile
// of ci/lighthouserc.cjs, pointed at one allowlisted origin instead of the
// fixture server. Run it through `npm run lighthouse:origin -- <origin>`, which
// validates the origin, discovers a published event and sets these variables.
// Threshold changes belong in ci/lighthouserc.cjs, never here.
module.exports = require("./lighthouse-origin-lib.cjs").configFromEnv();
