#!/usr/bin/env ts-node
/**
 * UpToCode Stop hook — building inspection report + auto-save.
 *
 * Fires when Claude finishes a response.
 *
 * Git workflow:
 *   - If on main/master and there are uncommitted changes, creates a
 *     session branch (claude/YYYY-MM-DD-HHmm) before committing.
 *   - Pushes the branch and opens a PR to main if one doesn't exist.
 *   - Subsequent sessions on the same branch update the same PR.
 *   - Already-committed unpushed work on main is pushed to main directly
 *     (preserves existing history before this feature was active).
 *
 * Exit codes:
 *   0 = clean, or informational output shown to user
 *   2 = unresolved violations remain (Claude re-activates to fix them)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runInspection, renderInspectionReport } from './src/inspect/runner';
import { Manifest } from './src/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ViolationEntry {
  ts: string;
  file: string;
  violations: Array<{ ruleId: string; severity: string; title: string; line?: number }>;
}

interface CleanEntry {
  ts: string;
  file: string;
  clean: true;
}

type LogEntry = ViolationEntry | CleanEntry;

interface PushResult {
  status: 'pushed' | 'up_to_date' | 'push_failed';
  branch: string;
  prUrl?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findProjectRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readSessionEntries(logDir: string, since: Date): LogEntry[] {
  const logPath = path.join(logDir, 'session.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
    .filter((e): e is LogEntry => e !== null && new Date(e.ts) > since);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

function getGitRemote(projectRoot: string): string | null {
  try { return run('git remote get-url origin', projectRoot) || null; } catch { return null; }
}

function authedRemote(remote: string): string {
  if (!remote.startsWith('https://')) return remote;
  try {
    const token = run('gh auth token', process.cwd());
    if (token) return remote.replace('https://', `https://x-access-token:${token}@`);
  } catch { /* gh not available */ }
  return remote;
}

function currentBranch(projectRoot: string): string {
  try { return run('git branch --show-current', projectRoot); } catch { return 'main'; }
}

function isMainBranch(branch: string): boolean {
  return branch === 'main' || branch === 'master';
}

function aheadCount(projectRoot: string): number {
  try {
    return parseInt(run('git rev-list --count @{u}..HEAD', projectRoot), 10);
  } catch {
    return 1; // new branch with no upstream — assume needs pushing
  }
}

function aheadOfMain(projectRoot: string): number {
  try {
    // Fetch first so origin refs are current (stale tracking = false up-to-date)
    run('git fetch --prune origin', projectRoot);
    const base = run('git symbolic-ref refs/remotes/origin/HEAD', projectRoot)
      .replace('refs/remotes/origin/', '') || 'main';
    return parseInt(run(`git rev-list --count origin/${base}..HEAD`, projectRoot), 10);
  } catch {
    return 1; // assume needs pushing if we can't tell
  }
}

function sessionBranchName(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  return `claude/${date}-${time}`;
}

function getOrCreatePr(projectRoot: string, branch: string, remote: string): string | undefined {
  try {
    // Check if PR already exists for this branch
    const existing = run(`gh pr view "${branch}" --json url -q .url`, projectRoot);
    if (existing) return existing;
  } catch { /* no existing PR */ }

  try {
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const base = run('git remote show origin | grep "HEAD branch" | awk \'{print $NF}\'', projectRoot) || 'main';
    const url = run(
      `gh pr create --title "Session: ${date} ${time}" ` +
      `--body "Automated checkpoint from UpToCode. The inspection report will be posted as a comment." ` +
      `--base "${base}" --head "${branch}"`,
      projectRoot,
    );
    return url || undefined;
  } catch {
    return undefined;
  }
}

function enableAutoMerge(projectRoot: string, branch: string): void {
  try {
    run(`gh pr merge "${branch}" --auto --squash`, projectRoot);
  } catch { /* auto-merge not available — branch protection may not be enabled */ }
}

function getBlockedPrs(projectRoot: string): Array<{ url: string; title: string }> {
  try {
    const json = run(
      `gh pr list --head "claude/" --state open --json url,title,statusCheckRollup`,
      projectRoot,
    );
    const prs: Array<{ url: string; title: string; statusCheckRollup: Array<{ state: string }> }> = JSON.parse(json);
    return prs.filter(pr =>
      pr.statusCheckRollup?.some(c => c.state === 'FAILURE' || c.state === 'ERROR')
    ).map(({ url, title }) => ({ url, title }));
  } catch {
    return [];
  }
}

// ── Core push logic ───────────────────────────────────────────────────────────

function autoCommitAndPush(projectRoot: string, remote: string): PushResult {
  try {
    const dirty = run('git status --porcelain', projectRoot);
    const branch = currentBranch(projectRoot);

    if (isMainBranch(branch) && dirty) {
      // New work on main — move it to a session branch
      const sessionBranch = sessionBranchName();
      run(`git checkout -b "${sessionBranch}"`, projectRoot);

      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      run(`git add -A && git commit -m "checkpoint: ${timestamp}"`, projectRoot);

      run(`git push -u "${authedRemote(remote)}" HEAD`, projectRoot);

      const prUrl = getOrCreatePr(projectRoot, sessionBranch, remote);
      return { status: 'pushed', branch: sessionBranch, prUrl };
    }

    if (!isMainBranch(branch)) {
      // Already on a session branch — commit if needed, then push
      if (dirty) {
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        run(`git add -A && git commit -m "checkpoint: ${timestamp}"`, projectRoot);
      }
      const ahead = aheadCount(projectRoot);
      // Also check commits ahead of main — catches the case where the branch's PR
      // was squash-merged but new commits were added afterwards (aheadCount returns 0
      // because upstream is up-to-date, but the commits aren't on main yet)
      const aheadMain = aheadOfMain(projectRoot);
      if (ahead === 0 && aheadMain === 0) return { status: 'up_to_date', branch };

      run(`git push -u "${authedRemote(remote)}" HEAD`, projectRoot);

      const prUrl = getOrCreatePr(projectRoot, branch, remote);
      return { status: 'pushed', branch, prUrl };
    }

    // On main with no uncommitted changes — push any unpushed commits directly
    const ahead = aheadCount(projectRoot);
    if (ahead === 0) return { status: 'up_to_date', branch };

    run(`git push "${authedRemote(remote)}"`, projectRoot);
    return { status: 'pushed', branch };
  } catch {
    return { status: 'push_failed', branch: currentBranch(projectRoot) };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const projectRoot = findProjectRoot();
  if (!projectRoot) process.exit(0);

  // ── Load manifest ──────────────────────────────────────────────────────────
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf-8'));
  } catch {
    // No manifest — push anyway
    const remote = getGitRemote(projectRoot);
    if (remote) {
      const pushResult = autoCommitAndPush(projectRoot, remote);
      if (pushResult.status === 'pushed') {
        const pr = pushResult.prUrl ? ` · PR: ${pushResult.prUrl}` : '';
        process.stdout.write(`UpToCode: ✓ Saved to GitHub${pr}\n`);
      }
    }
    process.exit(0);
  }

  // ── Check for violations before pushing ────────────────────────────────────
  const { violations } = runInspection(manifest, projectRoot, { skipTests: true });
  const critical = violations.filter(v => v.severity === 'CRITICAL' || v.severity === 'HIGH');

  if (critical.length > 0) {
    const lines = [
      `UpToCode: ${critical.length} violation(s) must be fixed before pushing:`,
      '',
    ];
    for (const v of critical) {
      const filePath = v.location ? path.relative(projectRoot, v.location.file) : '';
      const loc = v.location ? ` (${filePath}:${v.location.line})` : '';
      lines.push(`  ${v.ruleId} [${v.severity}]${loc} — ${v.title}`);
      lines.push(`  → call apply-fix: project_root="${projectRoot}", file_path="${filePath || 'unknown'}", rule_id="${v.ruleId}"`);
      lines.push('');
    }
    lines.push('Fix all violations using apply-fix, then I will push automatically.');
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(2);
  }

  // ── No violations — safe to push ───────────────────────────────────────────
  const remote = getGitRemote(projectRoot);
  let pushResult: PushResult | null = null;
  if (remote) {
    pushResult = autoCommitAndPush(projectRoot, remote);
  }

  // ── Read session log ───────────────────────────────────────────────────────
  const logDir = path.join(projectRoot, '.uptocode');
  const lastReportPath = path.join(logDir, 'last_report');
  const lastReport = fs.existsSync(lastReportPath)
    ? new Date(fs.readFileSync(lastReportPath, 'utf-8').trim())
    : new Date(0);

  const entries = readSessionEntries(logDir, lastReport);
  const violationEntries = entries.filter((e): e is ViolationEntry => !('clean' in e));
  const cleanEntries = entries.filter((e): e is CleanEntry => 'clean' in e);

  if (entries.length === 0) {
    if (pushResult?.status === 'pushed') {
      const pr = pushResult.prUrl ? ` · PR: ${pushResult.prUrl}` : '';
      process.stdout.write(`UpToCode: ✓ Saved to GitHub${pr}\n`);
    }
    process.exit(0);
  }

  // ── Session had activity — run full inspection ────────────────────────────
  const allViolations = violationEntries.flatMap(e => e.violations);
  const flaggedFiles = new Set(violationEntries.map(e => e.file));
  const resolvedFiles = new Set(cleanEntries.map(e => e.file).filter(f => flaggedFiles.has(f)));
  const openFiles = [...flaggedFiles].filter(f => !resolvedFiles.has(f));

  const inspectionResult = runInspection(manifest, projectRoot, { skipTests: true });

  const gitStatus = !remote ? 'no_remote'
    : pushResult?.status === 'pushed' ? 'pushed'
    : pushResult?.status === 'push_failed' ? 'push_failed'
    : 'pushed'; // up_to_date — already saved

  const report = renderInspectionReport(inspectionResult, {
    sessionViolations: allViolations.length,
    sessionFixed: resolvedFiles.size,
    gitStatus,
    remote: remote ?? undefined,
    prUrl: pushResult?.prUrl,
  });

  // ── Notify about any blocked session PRs ─────────────────────────────────
  if (remote) {
    const blocked = getBlockedPrs(projectRoot);
    if (blocked.length > 0) {
      const lines = ['', '  ⚠️  Open PR(s) blocked by failing inspection:'];
      for (const pr of blocked) {
        lines.push(`    ${pr.title} — ${pr.url}`);
      }
      lines.push('  Fix the violations above and they will auto-merge.');
      process.stdout.write(lines.join('\n') + '\n');
    }
  }

  process.stdout.write(report);

  // Auto-merge PR if inspection is clean and we have a PR open
  if (pushResult?.prUrl && pushResult.branch && openFiles.length === 0) {
    const hasCritical = inspectionResult.violations.some(v => v.severity === 'HIGH' || v.severity === 'CRITICAL')
      || inspectionResult.securityFindings.some(f => f.severity === 'HIGH');
    if (!hasCritical) {
      enableAutoMerge(projectRoot, pushResult.branch);
    }
  }

  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(lastReportPath, new Date().toISOString(), 'utf-8');
  } catch { /* non-fatal */ }

  // Only write to stderr (user-visible) when the user needs to take action
  if (pushResult?.status === 'push_failed') {
    process.stderr.write('UpToCode: could not push to GitHub — check your connection or run "git push" manually.\n');
  }

  process.exit(openFiles.length > 0 ? 2 : 0);
}

main();
