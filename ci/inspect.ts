/**
 * UpToCode CI inspection script.
 *
 * Runs the full local inspection (logic, security, adversarial tests) and
 * writes a markdown report to .uptocode-report.md for the GitHub Action.
 *
 * Usage:
 *   PROJECT_ROOT=/path/to/project ts-node --transpile-only ci/inspect.ts
 *
 * Exit codes:
 *   0 = all checks passed (or warnings only)
 *   1 = HIGH or CRITICAL violations found
 */

import * as fs from 'fs';
import * as path from 'path';
import { runInspection } from '../src/inspect/runner';
import { renderMarkdown } from '../src/adversarial/test-generator';
import { Manifest } from '../src/types';

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
  const { violations, securityFindings, testSuite, filesChecked } = runInspection(manifest, projectRoot);

  const highViolations = violations.filter(v => v.severity === 'HIGH' || v.severity === 'CRITICAL');
  const highFindings = securityFindings.filter(f => f.severity === 'HIGH');
  const highTests = testSuite.tests.filter(t => t.severity === 'HIGH').length;
  const hasCritical = highViolations.length > 0 || highFindings.length > 0;

  // ── Build report table ────────────────────────────────────────────────────
  const row = (check: string, result: string, finding: string) =>
    `| **${check}** | ${result} | ${finding} |`;

  const logicRow = row(
    'Logic Enforcement',
    violations.length === 0 ? '✅ Pass' : highViolations.length > 0 ? `❌ ${violations.length} violation(s)` : `⚠️ ${violations.length} warning(s)`,
    violations.length === 0
      ? `${filesChecked} files checked, all clear`
      : violations.slice(0, 2).map(v => `\`${v.ruleId}\`: ${v.title}`).join('; ') + (violations.length > 2 ? ` (+${violations.length - 2} more)` : ''),
  );

  const secRow = row(
    'Security Audit',
    securityFindings.length === 0 ? '✅ Pass' : highFindings.length > 0 ? `❌ ${securityFindings.length} issue(s)` : `⚠️ ${securityFindings.length} issue(s)`,
    securityFindings.length === 0
      ? 'No unguarded writes found'
      : securityFindings.slice(0, 2).map(f => f.description).join('; ') + (securityFindings.length > 2 ? ` (+${securityFindings.length - 2} more)` : ''),
  );

  const testRow = row(
    'Adversarial Tests',
    `⚠️ ${testSuite.tests.length} cases generated`,
    `${highTests} high-severity · see adversarial-tests.md`,
  );

  const dbRow = row('Database Health', '⏭️ Skipped', 'Live database check runs locally only');

  const passed = violations.length === 0 && securityFindings.length === 0;
  const sections = [
    `## UpToCode Inspection Report ${passed ? '✅' : hasCritical ? '❌' : '⚠️'}`,
    '',
    '| Check | Result | Finding |',
    '|---|---|---|',
    logicRow, secRow, testRow, dbRow,
  ];

  if (violations.length > 0) {
    sections.push('', '### Logic Violations');
    for (const v of violations) {
      const loc = v.location ? ` (${path.relative(projectRoot, v.location.file)}:${v.location.line})` : '';
      sections.push(`- \`${v.ruleId}\` [${v.severity}]${loc} — ${v.title}`);
      if (v.fixHint) sections.push(`  - Fix: ${v.fixHint}`);
    }
  }

  if (securityFindings.length > 0) {
    sections.push('', '### Security Findings');
    for (const f of securityFindings) {
      sections.push(`- [${f.severity}] ${f.description} (${path.relative(projectRoot, f.location.file)}:${f.location.line})`);
      sections.push(`  - Fix: ${f.fixHint}`);
    }
  }

  sections.push('', '*Inspected by [UpToCode](https://github.com/ashzade/UpToCode)*');
  fs.writeFileSync(reportPath, sections.join('\n'));

  // Write adversarial tests file for review
  if (testSuite.tests.length > 0) {
    fs.writeFileSync(path.join(projectRoot, 'adversarial-tests.md'), renderMarkdown(testSuite));
  }

  process.exit(hasCritical ? 1 : 0);
}

main().catch(err => {
  console.error('UpToCode CI error:', err);
  process.exit(1);
});
