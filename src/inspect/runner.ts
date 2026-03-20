/**
 * Shared inspection runner used by both the local Stop hook and the CI script.
 *
 * Runs all three local pillars — logic enforcement, security audit, adversarial
 * tests — and returns a structured result. Does not write any files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { contractDiff } from '../diff-engine/index';
import { CodeFile, Violation } from '../diff-engine/types';
import { Manifest } from '../types';
import { securityAudit, SecurityFinding } from '../security/access-auditor';
import { generateTests, TestSuite } from '../adversarial/test-generator';

// ── File collection ───────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.uptocode',
  '__pycache__', '.venv', 'venv', '.next', 'build',
]);
const CODE_EXTS = new Set(['.py', '.ts', '.js']);

export function collectCodeFiles(dir: string): CodeFile[] {
  const results: CodeFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectCodeFiles(full));
    } else if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      try {
        results.push({ path: full, content: fs.readFileSync(full, 'utf-8') });
      } catch { /* unreadable file — skip */ }
    }
  }
  return results;
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface InspectionResult {
  violations: Violation[];
  securityFindings: SecurityFinding[];
  testSuite: TestSuite;
  filesChecked: number;
  projectRoot: string;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runInspection(manifest: Manifest, projectRoot: string): InspectionResult {
  const files = collectCodeFiles(projectRoot);
  const violations = contractDiff(manifest, files).violations;
  const securityFindings = securityAudit(manifest, files).findings;
  const testSuite = generateTests(manifest);
  return { violations, securityFindings, testSuite, filesChecked: files.length, projectRoot };
}

// ── Report renderer (terminal) ────────────────────────────────────────────────

export function renderInspectionReport(result: InspectionResult, extras?: {
  sessionViolations?: number;
  sessionFixed?: number;
  gitStatus?: 'pushed' | 'no_remote' | 'push_failed';
  remote?: string;
}): string {
  const { violations, securityFindings, testSuite, filesChecked } = result;
  const highTests = testSuite.tests.filter(t => t.severity === 'HIGH').length;

  const logicStatus = violations.length === 0
    ? `✅  ${filesChecked} files · 0 violations`
    : `❌  ${violations.length} violation(s) in ${new Set(violations.map(v => v.location?.file)).size} file(s)`;

  const secStatus = securityFindings.length === 0
    ? '✅  No unguarded writes'
    : `❌  ${securityFindings.length} finding(s)`;

  const testStatus = `⚠️   ${testSuite.tests.length} cases · ${highTests} high-severity`;

  const lines: string[] = [
    '',
    '─────────────────────────────────────────────────────',
    '  UpToCode · Building Inspection Report',
    '─────────────────────────────────────────────────────',
    `  Logic Enforcement    ${logicStatus}`,
    `  Security Audit       ${secStatus}`,
    `  Adversarial Tests    ${testStatus}`,
    '  Database Health      ⏭️   Run scale-monitor to check',
  ];

  if (extras?.sessionViolations !== undefined) {
    lines.push('');
    const fixed = extras.sessionFixed ?? 0;
    const caught = extras.sessionViolations;
    lines.push(`  Session: ${caught} violation(s) caught · ${fixed} fixed`);
  }

  if (extras?.gitStatus === 'pushed' && extras.remote) {
    lines.push(`  ✓ Saved to GitHub · inspection running`);
  } else if (extras?.gitStatus === 'push_failed') {
    lines.push('  ⚠️  Could not push to GitHub — check your connection');
  } else if (extras?.gitStatus === 'no_remote') {
    lines.push('');
    lines.push('  → Say "Help me set up GitHub for this project" to');
    lines.push('    unlock automatic PR inspection reports.');
  }

  // Violation details
  if (violations.length > 0) {
    lines.push('');
    lines.push('  Violations:');
    for (const v of violations) {
      const loc = v.location ? ` (${path.relative(result.projectRoot, v.location.file)}:${v.location.line})` : '';
      lines.push(`    ${v.ruleId} [${v.severity}]${loc} — ${v.title}`);
    }
  }

  // Security details
  if (securityFindings.length > 0) {
    lines.push('');
    lines.push('  Security:');
    for (const f of securityFindings) {
      const loc = `${path.relative(result.projectRoot, f.location.file)}:${f.location.line}`;
      lines.push(`    [${f.severity}] ${f.description} (${loc})`);
    }
  }

  lines.push('─────────────────────────────────────────────────────');
  lines.push('');
  return lines.join('\n');
}
