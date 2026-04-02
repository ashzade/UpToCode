/**
 * UpToCode CI inspection script.
 *
 * Runs fast local inspection (logic enforcement + security audit) and
 * writes a markdown report to .uptocode-report.md for the GitHub Action.
 * Adversarial test generation runs separately on a nightly schedule.
 *
 * Also runs spec-drift if a base manifest can be retrieved from git
 * (i.e., on pull requests where GITHUB_BASE_REF is set).
 * Spec-drift results are written to .uptocode-drift.md separately so
 * the PR comment can be updated independently as a living checklist.
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
import { execSync } from 'child_process';
import { runInspection } from '../src/inspect/runner';
import { specDrift } from '../src/diff-engine/index';
import { Manifest } from '../src/types';
import { CodeFile, PlanItem } from '../src/diff-engine/types';

// ── Walk code files ──────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);

function walkCodeFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      results.push(...walkCodeFiles(full));
    } else if (entry.isFile() && /\.(py|ts|js)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Try to get the base manifest from git ───────────────────────

function getBaseManifest(projectRoot: string): Manifest | null {
  try {
    const baseRef = process.env.GITHUB_BASE_REF ?? 'main';
    const raw = execSync(`git show origin/${baseRef}:manifest.json`, {
      cwd: projectRoot,
      stdio: 'pipe',
    }).toString();
    return JSON.parse(raw) as Manifest;
  } catch {
    return null; // New project or no manifest on base — skip spec-drift
  }
}

// ── Render spec-drift checklist ──────────────────────────────────

function renderDriftChecklist(
  baseVersion: string,
  headVersion: string,
  plan: PlanItem[],
  completed: number,
  pending: number,
  projectRoot: string
): string {
  const total = plan.length;
  if (total === 0) return '';

  const bar = (done: number, all: number) => {
    const filled = Math.round((done / all) * 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const lines = [
    `## Guardian: Spec Drift v${baseVersion} → v${headVersion}`,
    `Progress: ${completed}/${total} items ${bar(completed, total)}`,
    '',
  ];

  // Group by category
  const ruleItems = plan.filter(i => i.ruleId);
  const fieldItems = plan.filter(i => !i.ruleId && i.description.toLowerCase().includes('field'));
  const otherItems = plan.filter(i => !i.ruleId && !i.description.toLowerCase().includes('field'));

  const renderItem = (item: PlanItem) => {
    const check = item.status === 'implemented' ? 'x' : ' ';
    const loc = item.location
      ? ` — \`${path.relative(projectRoot, item.location.file)}:${item.location.line}\``
      : item.status !== 'implemented' && item.fixHint
        ? ` — ${item.fixHint}`
        : '';
    return `- [${check}] ${item.description}${loc}`;
  };

  if (ruleItems.length > 0) {
    lines.push('### Rule Changes');
    ruleItems.forEach(i => lines.push(renderItem(i)));
    lines.push('');
  }
  if (fieldItems.length > 0) {
    lines.push('### Data Model Changes');
    fieldItems.forEach(i => lines.push(renderItem(i)));
    lines.push('');
  }
  if (otherItems.length > 0) {
    lines.push('### Other Changes');
    otherItems.forEach(i => lines.push(renderItem(i)));
    lines.push('');
  }

  if (pending === 0) {
    lines.push('✅ All spec changes are implemented.');
  } else {
    lines.push(`⚠️ ${pending} item(s) still need implementation before this PR is complete.`);
  }

  lines.push('', '*Updated by [UpToCode](https://github.com/ashzade/UpToCode) on every push*');
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
  const manifestPath = path.join(projectRoot, 'manifest.json');
  const reportPath = path.join(projectRoot, '.uptocode-report.md');
  const driftPath = path.join(projectRoot, '.uptocode-drift.md');

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
  const { violations, securityFindings, filesChecked } = await runInspection(manifest, projectRoot, { skipTests: true });

  const highViolations = violations.filter(v => v.severity === 'HIGH' || v.severity === 'CRITICAL');
  const highFindings = securityFindings.filter(f => f.severity === 'HIGH');
  const hasCritical = highViolations.length > 0 || highFindings.length > 0;

  // ── Spec drift ───────────────────────────────────────────────
  const baseManifest = getBaseManifest(projectRoot);
  let driftRow = '| **Spec Drift** | ⏭️ Skipped | Only runs on pull requests |';
  let driftContent = '';

  if (baseManifest) {
    const codeFiles: CodeFile[] = walkCodeFiles(projectRoot).map(p => ({
      path: p,
      content: fs.readFileSync(p, 'utf-8'),
    }));

    const driftResult = specDrift(baseManifest, manifest, codeFiles);
    const { progress } = driftResult;

    if (driftResult.delta.addedRules.length === 0 &&
        driftResult.delta.removedRules.length === 0 &&
        driftResult.delta.modifiedRules.length === 0 &&
        driftResult.delta.addedFields.length === 0 &&
        driftResult.delta.removedFields.length === 0) {
      driftRow = '| **Spec Drift** | ✅ No drift | Spec unchanged from base |';
    } else if (progress.pending === 0) {
      driftRow = `| **Spec Drift** | ✅ Pass | v${driftResult.baseVersion} → v${driftResult.headVersion}, all ${progress.total} change(s) implemented |`;
    } else {
      driftRow = `| **Spec Drift** | ⚠️ ${progress.pending} pending | v${driftResult.baseVersion} → v${driftResult.headVersion}, ${progress.completed}/${progress.total} implemented — see checklist below |`;
    }

    driftContent = renderDriftChecklist(
      driftResult.baseVersion,
      driftResult.headVersion,
      driftResult.refactorPlan,
      progress.completed,
      progress.pending,
      projectRoot
    );

    if (driftContent) {
      fs.writeFileSync(driftPath, driftContent);
    }
  }

  // ── Build report table ────────────────────────────────────────
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

  const testRow = row('Adversarial Tests', '⏭️ Nightly', 'Runs on schedule · trigger manually to run now');
  const dbRow = row('Database Health', '⏭️ Skipped', 'Live database check runs locally only');

  const passed = violations.length === 0 && securityFindings.length === 0;
  const sections = [
    `## UpToCode Inspection Report ${passed ? '✅' : hasCritical ? '❌' : '⚠️'}`,
    '',
    '| Check | Result | Finding |',
    '|---|---|---|',
    logicRow, secRow, driftRow, testRow, dbRow,
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

  process.exit(hasCritical ? 1 : 0);
}

main().catch(err => {
  console.error('UpToCode CI error:', err);
  process.exit(1);
});
