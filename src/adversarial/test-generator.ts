/**
 * Pillar 2: Adversarial Test Generator
 *
 * Derives test cases directly from a compiled Manifest. No AI required —
 * every test case is a logical consequence of a spec constraint.
 *
 * Test sources:
 *   1. Field modifiers   → missing required fields, invalid enum values, regex violations
 *   2. Logic rules       → condition inversion — inputs that violate each rule condition
 *   3. State machine     → invalid / out-of-order transitions
 *   4. Env vars          → env() references → missing/empty var scenarios
 */

import { Manifest, Rule, EnforcementDirective } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestCategory = 'field' | 'rule' | 'state' | 'env';
export type ExpectedOutcome = 'reject' | 'audit_log' | 'pass';

export interface TestCase {
  id: string;
  category: TestCategory;
  title: string;
  description: string;
  entityRef?: string;
  ruleRef?: string;
  /** Payload fields to set on the entity under test */
  payload: Record<string, unknown>;
  /** Env vars that must be UNSET for this test (env category) */
  unsetEnvVars?: string[];
  expected: ExpectedOutcome;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;       // from spec — what the system should return on rejection
}

export interface TestSuite {
  featureId: string;
  version: string;
  generatedAt: string;
  tests: TestCase[];
  summary: {
    total: number;
    byCategory: Record<TestCategory, number>;
    bySeverity: Record<string, number>;
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function generateTests(manifest: Manifest): TestSuite {
  const tests: TestCase[] = [];
  let seq = 1;

  const id = () => `T${String(seq++).padStart('03'.length, '0')}`;

  const enforcementMap = new Map<string, EnforcementDirective>();
  for (const d of manifest.enforcement) enforcementMap.set(d.ruleId, d);

  // ── 1. Field tests ───────────────────────────────────────────────────────
  for (const [entityName, entity] of Object.entries(manifest.dataModel)) {
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      const mods = field.modifiers.map(m => m.name);
      const isRequired = mods.includes('required');
      const isPrimary = mods.includes('primary');
      const isAutoGen = mods.includes('auto-gen');

      // Skip primary/auto-gen fields — callers don't supply them
      if (isPrimary || isAutoGen) continue;

      // Required field — test with missing value
      if (isRequired) {
        tests.push({
          id: id(),
          category: 'field',
          title: `${entityName}.${fieldName} missing`,
          description: `Omit required field '${fieldName}' from ${entityName} — should be rejected.`,
          entityRef: entityName,
          payload: { [fieldName]: null },
          expected: 'reject',
          severity: 'HIGH',
          message: `Field '${fieldName}' is required on ${entityName}.`,
        });

        // Also test empty string for string required fields
        if (field.type === 'string') {
          tests.push({
            id: id(),
            category: 'field',
            title: `${entityName}.${fieldName} empty string`,
            description: `Send empty string for required string field '${fieldName}' on ${entityName}.`,
            entityRef: entityName,
            payload: { [fieldName]: '' },
            expected: 'reject',
            severity: 'MEDIUM',
            message: `Field '${fieldName}' must not be empty.`,
          });
        }
      }

      // Enum field — test with invalid value
      const enumMod = field.modifiers.find(m => m.name === 'enum');
      if (enumMod) {
        tests.push({
          id: id(),
          category: 'field',
          title: `${entityName}.${fieldName} invalid enum`,
          description: `Send an unrecognised value for enum field '${fieldName}' on ${entityName}. Valid: ${enumMod.args.join(', ')}.`,
          entityRef: entityName,
          payload: { [fieldName]: '__invalid__' },
          expected: 'reject',
          severity: 'HIGH',
          message: `Field '${fieldName}' must be one of: ${enumMod.args.join(', ')}.`,
        });
      }

      // Regex field — test with violating value
      const regexMod = field.modifiers.find(m => m.name === 'regex');
      if (regexMod && regexMod.args[0]) {
        tests.push({
          id: id(),
          category: 'field',
          title: `${entityName}.${fieldName} fails regex`,
          description: `Send a value that violates the regex constraint ${regexMod.args[0]} on '${fieldName}'.`,
          entityRef: entityName,
          payload: { [fieldName]: 'INVALID_VALUE_###' },
          expected: 'reject',
          severity: 'MEDIUM',
          message: `Field '${fieldName}' does not match required format.`,
        });
      }
    }
  }

  // ── 2. Rule tests (condition inversion) ──────────────────────────────────
  for (const [ruleId, rule] of Object.entries(manifest.rules)) {
    const enforcement = enforcementMap.get(ruleId);
    const expected: ExpectedOutcome = enforcement
      ? (enforcement.responses.some(r => r.action === 'reject') ? 'reject' : 'audit_log')
      : 'reject';
    const severity = enforcement?.severity ?? 'MEDIUM';

    const inverted = invertCondition(rule.condition);
    for (const inv of inverted) {
      if (inv.kind === 'env') {
        tests.push({
          id: id(),
          category: 'env',
          title: `${ruleId}: ${rule.title} — ${inv.envVar} unset`,
          description: `Run with env var ${inv.envVar} unset or empty. Rule: "${rule.condition}". Expected: ${expected}.`,
          entityRef: rule.entity,
          ruleRef: ruleId,
          payload: {},
          unsetEnvVars: [inv.envVar],
          expected,
          severity: severity as TestCase['severity'],
          message: rule.message,
        });
      } else {
        tests.push({
          id: id(),
          category: 'rule',
          title: `${ruleId}: ${rule.title} — ${inv.description}`,
          description: `Violate ${ruleId} by setting ${JSON.stringify(inv.payload)}. Condition: "${rule.condition}". Expected: ${expected}.`,
          entityRef: rule.entity,
          ruleRef: ruleId,
          payload: inv.payload,
          expected,
          severity: severity as TestCase['severity'],
          message: rule.message,
        });
      }
    }
  }

  // ── 3. State machine tests ───────────────────────────────────────────────
  const states = Object.keys(manifest.stateMachine.states);
  const validTransitions = new Set(
    manifest.stateMachine.transitions.map(t => `${t.from}→${t.to}`)
  );

  // Generate all state pairs not present as valid transitions
  for (const from of states) {
    for (const to of states) {
      if (from === to) continue;
      const key = `${from}→${to}`;
      if (!validTransitions.has(key)) {
        tests.push({
          id: id(),
          category: 'state',
          title: `Invalid transition ${from} → ${to}`,
          description: `Attempt to move a ${manifest.feature.name} entity directly from ${from} to ${to}. This transition is not in the spec and should be rejected.`,
          payload: { status: to.toLowerCase() },
          expected: 'reject',
          severity: 'HIGH',
          message: `Transition from ${from} to ${to} is not permitted.`,
        });
      }
    }
  }

  // Test each guarded transition without satisfying the guard
  for (const t of manifest.stateMachine.transitions) {
    if (!t.guard) continue;
    const guardRule = manifest.rules[t.guard];
    if (!guardRule) continue;

    // Invert the guard condition to produce a payload that bypasses the guard
    const inverted = invertCondition(guardRule.condition);
    for (const inv of inverted) {
      if (inv.kind === 'env') continue; // env guards handled above
      tests.push({
        id: id(),
        category: 'state',
        title: `Transition ${t.from} → ${t.to} without satisfying guard ${t.guard}`,
        description: `Trigger ${t.from}→${t.to} with payload that violates guard ${t.guard} (${guardRule.title}): ${JSON.stringify(inv.payload)}.`,
        entityRef: guardRule.entity,
        ruleRef: t.guard,
        payload: { ...inv.payload },
        expected: 'reject',
        severity: 'HIGH',
        message: guardRule.message,
      });
    }
  }

  // ── 4. Env var tests (from all env() references across all rules) ────────
  const allEnvVars = new Set<string>();
  for (const rule of Object.values(manifest.rules)) {
    for (const m of rule.condition.matchAll(/\benv\(([^)]+)\)/gi)) {
      allEnvVars.add(m[1].trim());
    }
  }
  for (const prop of Object.values(manifest.computedProperties)) {
    for (const m of prop.filter.matchAll(/\benv\(([^)]+)\)/gi)) {
      allEnvVars.add(m[1].trim());
    }
  }

  for (const varName of allEnvVars) {
    // Check if already generated from rule inversion above
    const alreadyCovered = tests.some(
      t => t.category === 'env' && t.unsetEnvVars?.includes(varName)
    );
    if (alreadyCovered) continue;

    tests.push({
      id: id(),
      category: 'env',
      title: `Missing env var ${varName}`,
      description: `Run with ${varName} unset. Any operation that depends on it should be rejected or skipped.`,
      payload: {},
      unsetEnvVars: [varName],
      expected: 'reject',
      severity: 'MEDIUM',
      message: `Environment variable ${varName} is not configured.`,
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const byCategory = { field: 0, rule: 0, state: 0, env: 0 } as Record<TestCategory, number>;
  const bySeverity: Record<string, number> = {};
  for (const t of tests) {
    byCategory[t.category]++;
    bySeverity[t.severity] = (bySeverity[t.severity] ?? 0) + 1;
  }

  return {
    featureId: manifest.meta.featureId,
    version: manifest.meta.version,
    generatedAt: new Date().toISOString(),
    tests,
    summary: { total: tests.length, byCategory, bySeverity },
  };
}

// ── Condition inverter ────────────────────────────────────────────────────────

type InvertedAtom =
  | { kind: 'payload'; description: string; payload: Record<string, unknown> }
  | { kind: 'env'; envVar: string };

/**
 * Given a predicate condition string, return a list of atoms that each
 * independently violate the condition.
 *
 * Strategy: split on AND (each AND sub-expression must hold; violating ANY
 * one of them violates the whole condition). OR sub-expressions are harder
 * to violate — skip them for now (conservative).
 */
function invertCondition(condition: string): InvertedAtom[] {
  const results: InvertedAtom[] = [];

  // Split on AND at the top level (ignore nested parens for now)
  const atoms = splitTopLevelAnd(condition);

  for (const atom of atoms) {
    const trimmed = atom.trim();

    // env(VAR) != ''  or  env(VAR) != 'null'
    const envMatch = trimmed.match(/\benv\(([^)]+)\)\s*!=\s*['"]/);
    if (envMatch) {
      results.push({ kind: 'env', envVar: envMatch[1].trim() });
      continue;
    }

    // entity.field != '' → payload: { field: '' }
    const neqEmpty = trimmed.match(/^entity\.(\w+)\s*!=\s*''$/);
    if (neqEmpty) {
      results.push({
        kind: 'payload',
        description: `${neqEmpty[1]} = '' (empty)`,
        payload: { [neqEmpty[1]]: '' },
      });
      continue;
    }

    // entity.field != 'value' → payload: { field: 'value' }
    const neqStr = trimmed.match(/^entity\.(\w+)\s*!=\s*'([^']*)'$/);
    if (neqStr) {
      results.push({
        kind: 'payload',
        description: `${neqStr[1]} = '${neqStr[2]}'`,
        payload: { [neqStr[1]]: neqStr[2] },
      });
      continue;
    }

    // entity.field == 'value' → payload: { field: '__wrong__' }
    const eqStr = trimmed.match(/^entity\.(\w+)\s*==\s*'([^']*)'$/);
    if (eqStr) {
      results.push({
        kind: 'payload',
        description: `${eqStr[1]} != '${eqStr[2]}' (wrong value)`,
        payload: { [eqStr[1]]: '__wrong__' },
      });
      continue;
    }

    // entity.field == true/false
    const eqBool = trimmed.match(/^entity\.(\w+)\s*==\s*(true|false)$/i);
    if (eqBool) {
      const inverted = eqBool[2].toLowerCase() === 'true' ? false : true;
      results.push({
        kind: 'payload',
        description: `${eqBool[1]} = ${inverted}`,
        payload: { [eqBool[1]]: inverted },
      });
      continue;
    }

    // computed_prop == false → computed_prop = true (represented as payload hint)
    const computedFalse = trimmed.match(/^([a-z_]+)\s*==\s*false$/i);
    if (computedFalse) {
      results.push({
        kind: 'payload',
        description: `computed '${computedFalse[1]}' is true (condition violated)`,
        payload: { __computed__: computedFalse[1] + ' == true' },
      });
      continue;
    }

    // entity.field > n → payload: { field: n } (boundary)
    const gt = trimmed.match(/^entity\.(\w+)\s*>\s*(\d+)$/);
    if (gt) {
      results.push({
        kind: 'payload',
        description: `${gt[1]} = ${gt[2]} (at boundary, not >)`,
        payload: { [gt[1]]: Number(gt[2]) },
      });
      continue;
    }

    // entity.field >= n → payload: { field: n-1 }
    const gte = trimmed.match(/^entity\.(\w+)\s*>=\s*(\d+)$/);
    if (gte) {
      const n = Number(gte[2]);
      results.push({
        kind: 'payload',
        description: `${gte[1]} = ${n - 1} (below minimum)`,
        payload: { [gte[1]]: n - 1 },
      });
      continue;
    }

    // entity.field < n → payload: { field: n }
    const lt = trimmed.match(/^entity\.(\w+)\s*<\s*(\d+)$/);
    if (lt) {
      results.push({
        kind: 'payload',
        description: `${lt[1]} = ${lt[2]} (at boundary, not <)`,
        payload: { [lt[1]]: Number(lt[2]) },
      });
      continue;
    }

    // NOT entity.field → test with field = truthy
    const notField = trimmed.match(/^NOT\s+entity\.(\w+)$/i);
    if (notField) {
      results.push({
        kind: 'payload',
        description: `${notField[1]} is truthy (violates NOT condition)`,
        payload: { [notField[1]]: true },
      });
      continue;
    }
  }

  return results;
}

/**
 * Split a condition string on AND, respecting parenthesis depth.
 */
function splitTopLevelAnd(condition: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  const tokens = condition.split(/(\s+AND\s+|\s*\(\s*|\s*\)\s*)/i);

  for (const token of tokens) {
    if (/^\s*\(\s*$/.test(token)) { depth++; current += token; }
    else if (/^\s*\)\s*$/.test(token)) { depth--; current += token; }
    else if (/^\s+AND\s+$/i.test(token) && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += token;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

// ── Markdown report builder ───────────────────────────────────────────────────

export function renderMarkdown(suite: TestSuite): string {
  const lines: string[] = [
    `# Adversarial Test Suite — ${suite.featureId} v${suite.version}`,
    ``,
    `Generated: ${suite.generatedAt}`,
    ``,
    `## Summary`,
    ``,
    `| Category | Count |`,
    `|---|---|`,
    `| Field validation | ${suite.summary.byCategory.field} |`,
    `| Rule violation | ${suite.summary.byCategory.rule} |`,
    `| State machine | ${suite.summary.byCategory.state} |`,
    `| Env var | ${suite.summary.byCategory.env} |`,
    `| **Total** | **${suite.summary.total}** |`,
    ``,
    `| Severity | Count |`,
    `|---|---|`,
    ...Object.entries(suite.summary.bySeverity).map(([s, n]) => `| ${s} | ${n} |`),
    ``,
    `---`,
    ``,
  ];

  const byCategory: Record<string, TestCase[]> = {
    'Field Validation': suite.tests.filter(t => t.category === 'field'),
    'Rule Violations': suite.tests.filter(t => t.category === 'rule'),
    'State Machine': suite.tests.filter(t => t.category === 'state'),
    'Environment Variables': suite.tests.filter(t => t.category === 'env'),
  };

  for (const [section, tests] of Object.entries(byCategory)) {
    if (tests.length === 0) continue;
    lines.push(`## ${section}`, ``);
    for (const t of tests) {
      lines.push(
        `### ${t.id}: ${t.title}`,
        ``,
        `**Severity:** ${t.severity} | **Expected:** ${t.expected}${t.ruleRef ? ` | **Rule:** ${t.ruleRef}` : ''}${t.entityRef ? ` | **Entity:** ${t.entityRef}` : ''}`,
        ``,
        t.description,
        ``,
      );
      if (Object.keys(t.payload).length > 0) {
        lines.push(
          `**Payload:**`,
          `\`\`\`json`,
          JSON.stringify(t.payload, null, 2),
          `\`\`\``,
          ``,
        );
      }
      if (t.unsetEnvVars && t.unsetEnvVars.length > 0) {
        lines.push(`**Unset env vars:** \`${t.unsetEnvVars.join('`, `')}\``, ``);
      }
      lines.push(`**On failure the system should say:** "${t.message}"`, ``, `---`, ``);
    }
  }

  return lines.join('\n');
}
