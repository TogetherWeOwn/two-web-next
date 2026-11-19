import { workflowRunPlainData } from "./workflow-run-discovery.mjs";

const stepId = /^[a-z_][a-z0-9_-]*$/i;
const outcomeSuccess = /^steps\.([a-z_][a-z0-9_-]*)\.outcome\s*==\s*'success'$/i;
const eventCondition =
  /^(?:github\.event_name\s*==\s*'[a-z_]+'|inputs\.[a-z_][a-z0-9_-]*\s*!=\s*'')$/i;

function conditionTerms(step) {
  if (!Object.hasOwn(step, "if") || step.if === true) return ["true"];
  if (typeof step.if !== "string" || step.if.length > 1024) return [];
  const condition = step.if.trim();
  const body =
    condition.startsWith("${{") && condition.endsWith("}}") ? condition.slice(3, -2) : condition;
  return body.split("&&").map((term) => term.trim());
}

// Only for a workflow-level run and a separate earlier step in that same job.
// This proves a scheduling dependency, not what the prerequisite executes.
export function requiresPriorStepSuccess({ step, precedingSteps }, prerequisiteIndex) {
  if (!Number.isInteger(prerequisiteIndex) || prerequisiteIndex < 0) return false;
  const prerequisite = precedingSteps[prerequisiteIndex];
  if (!prerequisite) return false;

  const terms = conditionTerms(step);
  const id =
    typeof prerequisite.id === "string" && stepId.test(prerequisite.id)
      ? prerequisite.id.toLowerCase()
      : undefined;
  let checksOutcome = false;
  for (const term of terms) {
    const outcome = outcomeSuccess.exec(term);
    if (outcome && id && outcome[1].toLowerCase() === id) checksOutcome = true;
    else if (!["true", "success()", "!cancelled()"].includes(term) && !eventCondition.test(term)) {
      return false;
    }
  }

  // The raw outcome is recorded before continue-on-error is applied. Do not
  // substitute conclusion, or let a different step supply this id.
  if (checksOutcome) {
    const matches = precedingSteps.filter(
      (prior) => typeof prior.id === "string" && prior.id.toLowerCase() === id,
    );
    return matches.length === 1;
  }

  // With no explicit status predicate, Actions adds success(). This excludes
  // an unmasked failure but does not exclude a skipped prerequisite.
  const earlierTerms = conditionTerms(prerequisite);
  return (
    terms.length > 0 &&
    (!terms.includes("!cancelled()") || terms.includes("success()")) &&
    (!Object.hasOwn(prerequisite, "continue-on-error") ||
      prerequisite["continue-on-error"] === false) &&
    earlierTerms.length === 1 &&
    (earlierTerms[0] === "true" || earlierTerms[0] === "success()")
  );
}

// Both runs must come from the same discovery pass. The caller independently
// classifies the install command and checkout inputs; this binds their slots
// and proves the two scheduling dependencies without observing a runtime result.
export function observeWorkflowPrerequisites(terminal, install, checkoutStep) {
  const { workflow, job, step } = terminal.origin;
  const installStep = install.origin.step;
  if (
    install.job !== terminal.job ||
    install.origin.workflow !== workflow ||
    install.origin.job !== job ||
    installStep >= step ||
    terminal.precedingSteps[installStep] !== install.step ||
    terminal.precedingSteps[checkoutStep] !== install.precedingSteps[checkoutStep]
  ) {
    throw new Error(`${workflow}: checkout and install must precede the terminal in the same job`);
  }

  const installContext = workflowRunPlainData(install);
  const checkout = installContext.precedingSteps[checkoutStep];
  if (
    typeof checkout?.uses !== "string" ||
    !/^actions\/checkout@[a-f0-9]{40}$/.test(checkout.uses) ||
    Object.hasOwn(checkout, "run") ||
    !requiresPriorStepSuccess(installContext, checkoutStep)
  ) {
    throw new Error(`${workflow}: install does not require a successful pinned checkout`);
  }
  if (!requiresPriorStepSuccess(workflowRunPlainData(terminal), installStep)) {
    throw new Error(`${workflow}: terminal does not require a successful install`);
  }
  return {
    checkout: { step: checkoutStep, uses: checkout.uses },
    install: { step: installStep, dependency: "required-success" },
  };
}
