/**
 * Adversarial test evaluator — static analysis.
 *
 * Determines which generated test cases FAIL in the current codebase without
 * executing any code. Uses message-presence and pattern heuristics:
 *
 * - Field / rule / env tests: the expected rejection message must appear
 *   somewhere in the source. If it's not there, the guard is not implemented.
 *
 * - State machine tests: instead of checking every transition individually,
 *   we verify that a state machine guard exists (assertValidTransition /
 *   InvalidTransitionError + "is not permitted" message). If the guard is
 *   absent, ALL state tests fail.
 *
 * Trade-offs: false negatives possible (guard present but message differs),
 * false positives rare. Good enough to surface the 80 % of unguarded cases
 * that actually matter.
 */

import { TestCase, TestSuite } from './test-generator';
import { CodeFile } from '../diff-engine/types';

// ── Result types ──────────────────────────────────────────────────────────────

export interface TestEvalResult {
  testId: string;
  category: TestCase['category'];
  title: string;
  severity: TestCase['severity'];
  passed: boolean;
  /** Evidence found in the codebase (present → pass) or what was missing (fail). */
  evidence: string;
  /** Expected message the system should emit on rejection. */
  expectedMessage: string;
  /** Entity or rule reference for grouping. */
  ref?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  failedByCategory: Record<TestCase['category'], number>;
  failedBySeverity: Record<string, number>;
}

export interface EvalReport {
  results: TestEvalResult[];
  summary: EvalSummary;
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

export function evaluateTests(suite: TestSuite, files: CodeFile[]): EvalReport {
  const allCode = files.map(f => f.content).join('\n');

  // Pre-compute: does a state machine guard exist at all?
  const hasStateMachineGuard = detectStateMachineGuard(allCode);

  const results: TestEvalResult[] = suite.tests.map(test =>
    evaluateOne(test, allCode, hasStateMachineGuard)
  );

  const failed = results.filter(r => !r.passed);
  const failedByCategory: Record<TestCase['category'], number> = {
    field: 0, rule: 0, state: 0, env: 0,
  };
  const failedBySeverity: Record<string, number> = {};
  for (const r of failed) {
    failedByCategory[r.category]++;
    failedBySeverity[r.severity] = (failedBySeverity[r.severity] ?? 0) + 1;
  }

  return {
    results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: failed.length,
      failedByCategory,
      failedBySeverity,
    },
  };
}

// ── Per-test evaluation ───────────────────────────────────────────────────────

function evaluateOne(
  test: TestCase,
  allCode: string,
  hasStateMachineGuard: boolean,
): TestEvalResult {
  let passed: boolean;
  let evidence: string;

  switch (test.category) {
    case 'field':
    case 'rule':
      ({ passed, evidence } = evaluateMessagePresence(test, allCode));
      break;

    case 'env':
      ({ passed, evidence } = evaluateEnvGuard(test, allCode));
      break;

    case 'state':
      ({ passed, evidence } = evaluateStateTransition(test, allCode, hasStateMachineGuard));
      break;
  }

  return {
    testId: test.id,
    category: test.category,
    title: test.title,
    severity: test.severity,
    passed,
    evidence,
    expectedMessage: test.message,
    ref: test.entityRef ?? test.ruleRef,
  };
}

// ── Field / Rule: message-presence heuristic ─────────────────────────────────

function evaluateMessagePresence(
  test: TestCase,
  allCode: string,
): { passed: boolean; evidence: string } {
  // Primary check: exact message string in source
  if (allCode.includes(test.message)) {
    return { passed: true, evidence: `message found: "${test.message}"` };
  }

  // Secondary: partial match on the core fragment (handles minor wording diffs)
  const core = extractCoreFragment(test.message);
  if (core && allCode.includes(core)) {
    return { passed: true, evidence: `partial match on: "${core}"` };
  }

  // Tertiary (field tests only): entity-level validator function exists for this entity
  if (test.category === 'field' && test.entityRef) {
    const entityId = entityToFunctionName(test.entityRef);
    const validatorPattern = new RegExp(`function validate${entityId}|validate${entityId}\\s*=`, 'i');
    if (validatorPattern.test(allCode)) {
      // Validator function exists — check that it references this field
      const fieldName = Object.keys(test.payload)[0];
      if (fieldName && allCode.includes(fieldName)) {
        return {
          passed: true,
          evidence: `validator function validate${entityId} found and references field '${fieldName}'`,
        };
      }
    }
  }

  return {
    passed: false,
    evidence: `message not found in codebase: "${test.message}"`,
  };
}

/**
 * Extract a shorter, unambiguous fragment from a message that's less likely
 * to have been rephrased. E.g. "Field 'terms' is required" → "terms' is required".
 */
function extractCoreFragment(message: string): string | null {
  // "Field 'X' is required on Y." → "'X' is required"
  const reqMatch = message.match(/'([^']+)' is required/);
  if (reqMatch) return `'${reqMatch[1]}' is required`;

  // "Field 'X' must not be empty." → "'X' must not be empty"
  const emptyMatch = message.match(/'([^']+)' must not be empty/);
  if (emptyMatch) return `'${emptyMatch[1]}' must not be empty`;

  return null;
}

/**
 * Convert an entity display name to the function name fragment used in
 * validator functions. E.g. "ParsedQuery (in-memory)" → "ParsedQuery".
 */
function entityToFunctionName(entityRef: string): string {
  return entityRef
    .replace(/\s*\(.*?\)/, '')   // remove "(in-memory)" suffix
    .replace(/\s+/g, '')         // remove spaces
    .replace(/[^a-zA-Z0-9]/g, ''); // remove non-alnum
}

// ── Env var: guard-pattern heuristic ─────────────────────────────────────────

function evaluateEnvGuard(
  test: TestCase,
  allCode: string,
): { passed: boolean; evidence: string } {
  const varName = test.unsetEnvVars?.[0];
  if (!varName) return { passed: true, evidence: 'no env var to check' };

  // Look for: !process.env.VAR, process.env.VAR == null, process.env.VAR === undefined,
  //           !env.VAR, env.VAR == null, etc.
  const guardPatterns = [
    new RegExp(`!process\\.env\\.${varName}\\b`),
    new RegExp(`process\\.env\\.${varName}\\s*(?:==|===)\\s*(?:null|undefined|''|"")`),
    new RegExp(`!env\\b.*${varName}`),
    new RegExp(`ENV\\.${varName}\\s*(?:is\\s+)?(?:None|null|undefined)`),
    // Python: os.environ.get('VAR') guard
    new RegExp(`os\\.environ(?:\\.get)?\\(\\s*['"]${varName}['"]\\s*\\)`),
  ];

  for (const pattern of guardPatterns) {
    if (pattern.test(allCode)) {
      return { passed: true, evidence: `env guard found for ${varName}` };
    }
  }

  // Fallback: the rejection message appears in the code
  if (allCode.includes(test.message)) {
    return { passed: true, evidence: `rejection message found for ${varName}` };
  }

  // Check for partial message
  const core = extractCoreFragment(test.message);
  if (core && allCode.includes(core)) {
    return { passed: true, evidence: `partial rejection message found for ${varName}` };
  }

  return {
    passed: false,
    evidence: `no runtime guard found for env var ${varName}`,
  };
}

// ── State machine: guard-existence heuristic ─────────────────────────────────

/**
 * Returns true if the codebase contains a state machine guard —
 * i.e. something that enforces valid transitions at runtime.
 */
function detectStateMachineGuard(allCode: string): boolean {
  const patterns = [
    /assertValidTransition/,
    /InvalidTransitionError/,
    /isValidTransition/,
    /Transition from .+ to .+ is not permitted/,
    // Python-style
    /invalid.*transition/i,
    /transition.*not.*permitted/i,
    /allowed_transitions/i,
    /valid_transitions/i,
  ];
  return patterns.some(p => p.test(allCode));
}

function evaluateStateTransition(
  test: TestCase,
  allCode: string,
  hasStateMachineGuard: boolean,
): { passed: boolean; evidence: string } {
  if (!hasStateMachineGuard) {
    return {
      passed: false,
      evidence: 'no state machine guard found in codebase (assertValidTransition / isValidTransition / InvalidTransitionError)',
    };
  }

  // Guard exists — check whether the specific transition message is covered,
  // or whether the guard is generic enough to cover all invalid transitions.
  if (allCode.includes(test.message)) {
    return { passed: true, evidence: `transition message found: "${test.message}"` };
  }

  // Generic guard present — it blocks all invalid transitions structurally,
  // so individual transition tests pass.
  return {
    passed: true,
    evidence: 'generic state machine guard present (covers all invalid transitions)',
  };
}

// ── Failure report renderer ───────────────────────────────────────────────────

/**
 * Render the failing tests as an actionable block for Claude to act on.
 * This is appended to the generate-tests MCP response.
 */
export function renderFailureBlock(report: EvalReport): string {
  const { summary, results } = report;
  const failures = results.filter(r => !r.passed);

  if (failures.length === 0) {
    return '\n✅ All adversarial tests pass — guards are in place.\n';
  }

  const lines: string[] = [
    '',
    `⚠️  ${summary.failed}/${summary.total} adversarial tests FAIL in this codebase.`,
    `   Fix these before the session ends.`,
    '',
  ];

  // Group by category for readability
  const byCategory: Partial<Record<TestCase['category'], TestEvalResult[]>> = {};
  for (const f of failures) {
    (byCategory[f.category] ??= []).push(f);
  }

  const categoryLabels: Record<TestCase['category'], string> = {
    field: 'Field Validation',
    rule: 'Rule Enforcement',
    state: 'State Machine',
    env: 'Environment Variables',
  };

  for (const [cat, items] of Object.entries(byCategory) as [TestCase['category'], TestEvalResult[]][]) {
    if (!items?.length) continue;
    lines.push(`## ${categoryLabels[cat]} Failures (${items.length})`);
    lines.push('');
    for (const item of items) {
      lines.push(`- **${item.testId}** [${item.severity}] ${item.title}`);
      lines.push(`  System should say: "${item.expectedMessage}"`);
      lines.push(`  Missing: ${item.evidence}`);
    }
    lines.push('');
  }

  lines.push(
    `Fix each failure by adding the missing runtime guard.`,
    `For field validation: add a validator function that throws with the expected message.`,
    `For state machine: add assertValidTransition calls at each pipeline step.`,
    `For env vars: add a guard that rejects when the variable is unset.`,
  );

  return lines.join('\n');
}
