/**
 * UpToCode CI inspection script.
 *
 * Runs contract-diff, security-audit, and generate-tests against the project.
 * Writes a markdown report to .uptocode-report.md for the GitHub Action to post.
 *
 * Usage:
 *   PROJECT_ROOT=/path/to/project ts-node --transpile-only ci/inspect.ts
 *
 * Exit codes:
 *   0 = all checks passed (or only warnings)
 *   1 = HIGH or CRITICAL violations found
 */

import * as fs from 'fs';
import * as path from 'path';
import { contractDiff } from '../src/diff-engine/index';
import { CodeFile } from '../src/diff-engine/types';
import { Manifest } from '../src/types';
import { securityAudit } from '../src/security/access-auditor';
import { generateTests, renderMarkdown } from '../src/adversarial/test-generator';

// ── File collection ───────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.uptocode', '__pycache__', '.venv', 'venv']);
const CODE_EXTS = new Set(['.py', '.ts', '.js']);

function collectCodeFiles(dir: string): CodeFile[] {
  const results: CodeFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectCodeFiles(full));
    } else if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push({ path: full, content: fs.readFileSync(full, 'utf-8') });
    }
  }
  return results;
}

// ── Report row builder ────────────────────────────────────────────────────────

function row(check: string, result: string, finding: string): string {
  return `| **${check}** | ${result} | ${finding} |`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
  const manifestPath = path.join(projectRoot, 'manifest.json');
  const reportPath = path.join(projectRoot, '.uptocode-report.md');

  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(reportPath, [
      '## UpToCode Inspection',
      '',
      '> ⚠️ No `manifest.json` found.',
      '> Run *"Interview me to build my spec"* in Claude Code to set up UpToCode, then commit `manifest.json`.',
      '',
      '*Inspected by [UpToCode](https://github.com/ashzade/UpToCode)*',
    ].join('\n'));
    process.exit(0);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const files = collectCodeFiles(projectRoot);

  // ── 1. Logic enforcement ──────────────────────────────────────────────────
  const diffResult = contractDiff(manifest, files);
  const violations = diffResult.violations;
  const highViolations = violations.filter(v => v.severity === 'HIGH' || v.severity === 'CRITICAL');

  const logicRow = row(
    'Logic Enforcement',
    violations.length === 0
      ? '✅ Pass'
      : highViolations.length > 0 ? `❌ ${violations.length} violation(s)` : `⚠️ ${violations.length} warning(s)`,
    violations.length === 0
      ? `${files.length} files checked, all clear`
      : violations.slice(0, 2).map(v => `\`${v.ruleId}\`: ${v.title}`).join('; ') +
        (violations.length > 2 ? ` (+${violations.length - 2} more)` : ''),
  );

  // ── 2. Security audit ─────────────────────────────────────────────────────
  const secResult = securityAudit(manifest, files);
  const findings = secResult.findings;
  const highFindings = findings.filter(f => f.severity === 'HIGH');

  const secRow = row(
    'Security Audit',
    findings.length === 0
      ? '✅ Pass'
      : highFindings.length > 0 ? `❌ ${findings.length} issue(s)` : `⚠️ ${findings.length} issue(s)`,
    findings.length === 0
      ? 'No unguarded writes found'
      : findings.slice(0, 2).map(f => f.description).join('; ') +
        (findings.length > 2 ? ` (+${findings.length - 2} more)` : ''),
  );

  // ── 3. Adversarial tests ──────────────────────────────────────────────────
  const suite = generateTests(manifest);
  const testCount = suite.tests.length;
  const highTests = suite.tests.filter(t => t.severity === 'HIGH').length;

  const testRow = row(
    'Adversarial Tests',
    `⚠️ ${testCount} cases generated`,
    `${highTests} high-severity · see adversarial-tests.md`,
  );

  // Write the test file so it can be reviewed
  if (testCount > 0) {
    fs.writeFileSync(path.join(projectRoot, 'adversarial-tests.md'), renderMarkdown(suite));
  }

  // ── 4. Database health ────────────────────────────────────────────────────
  const dbRow = row(
    'Database Health',
    '⏭️ Skipped',
    'Live database check runs locally only',
  );

  // ── Build report ──────────────────────────────────────────────────────────
  const passed = violations.length === 0 && findings.length === 0;
  const hasCritical = highViolations.length > 0 || highFindings.length > 0;

  const sections: string[] = [
    `## UpToCode Inspection Report ${passed ? '✅' : hasCritical ? '❌' : '⚠️'}`,
    '',
    '| Check | Result | Finding |',
    '|---|---|---|',
    logicRow,
    secRow,
    testRow,
    dbRow,
  ];

  if (violations.length > 0) {
    sections.push('', '### Logic Violations');
    for (const v of violations) {
      const loc = v.location ? ` (${path.relative(projectRoot, v.location.file)}:${v.location.line})` : '';
      sections.push(`- \`${v.ruleId}\` [${v.severity}]${loc} — ${v.title}`);
      if (v.fixHint) sections.push(`  - Fix: ${v.fixHint}`);
    }
  }

  if (findings.length > 0) {
    sections.push('', '### Security Findings');
    for (const f of findings) {
      const loc = `${path.relative(projectRoot, f.location.file)}:${f.location.line}`;
      sections.push(`- [${f.severity}] ${f.description} (${loc})`);
      sections.push(`  - Fix: ${f.fixHint}`);
    }
  }

  sections.push('', '*Inspected by [UpToCode](https://github.com/ashzade/UpToCode)*');

  fs.writeFileSync(reportPath, sections.join('\n'));

  process.exit(hasCritical ? 1 : 0);
}

main().catch(err => {
  console.error('UpToCode CI error:', err);
  process.exit(1);
});
