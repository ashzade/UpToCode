#!/usr/bin/env ts-node
/**
 * UpToCode Stop hook — building inspection report + auto-save.
 *
 * Fires when Claude finishes a response.
 *
 * Always: auto-commits any changed files and pushes to GitHub if a remote
 * is configured (using `gh auth token` for HTTPS auth).
 *
 * If there was session log activity (violations caught or fixed): runs the
 * full local inspection and prints a plain-English report.
 *
 * Exit codes:
 *   0 = clean, or informational report shown to user
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

// ── Find project root (via manifest.json) ─────────────────────────────────────

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

// ── Session log helpers ───────────────────────────────────────────────────────

function readSessionEntries(logDir: string, since: Date): LogEntry[] {
  const logPath = path.join(logDir, 'session.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
    .filter((e): e is LogEntry => e !== null && new Date(e.ts) > since);
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function getGitRemote(projectRoot: string): string | null {
  try {
    return execSync('git remote get-url origin', {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Returns a push URL with the gh token embedded for reliable HTTPS auth. */
function authedRemote(remote: string): string {
  if (!remote.startsWith('https://')) return remote;
  try {
    const token = execSync('gh auth token', {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    if (token) return remote.replace('https://', `https://x-access-token:${token}@`);
  } catch { /* gh not available — fall through */ }
  return remote;
}

function autoCommitAndPush(projectRoot: string): 'pushed' | 'up_to_date' | 'push_failed' {
  try {
    // Commit any uncommitted changes
    const dirty = execSync('git status --porcelain', {
      cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();

    if (dirty) {
      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      execSync(`git add -A && git commit -m "checkpoint: ${timestamp}"`, {
        cwd: projectRoot, shell: '/bin/bash', stdio: 'pipe',
      });
    }

    // Check if we're ahead of remote (catches already-committed but unpushed work)
    let aheadCount = 0;
    try {
      aheadCount = parseInt(
        execSync('git rev-list --count @{u}..HEAD', {
          cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
        }).toString().trim(),
        10,
      );
    } catch {
      // No upstream set or first push — assume push is needed if we committed
      aheadCount = dirty ? 1 : 0;
    }

    if (aheadCount === 0) return 'up_to_date';

    const remote = execSync('git remote get-url origin', {
      cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();

    execSync(`git push "${authedRemote(remote)}"`, {
      cwd: projectRoot, shell: '/bin/bash', stdio: 'pipe',
    });
    return 'pushed';
  } catch {
    return 'push_failed';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const projectRoot = findProjectRoot();
  if (!projectRoot) process.exit(0);

  // ── Auto-commit and push first — always, regardless of session activity ────
  const remote = getGitRemote(projectRoot);
  let gitStatus: 'pushed' | 'no_remote' | 'push_failed' | 'up_to_date' = 'no_remote';
  if (remote) {
    const result = autoCommitAndPush(projectRoot);
    gitStatus = result;
  }

  // ── Load manifest (needed for inspection) ─────────────────────────────────
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf-8'));
  } catch {
    // No manifest — just print push status if relevant and exit
    if (gitStatus === 'pushed') {
      process.stdout.write('UpToCode: ✓ Saved to GitHub\n');
    }
    process.exit(0);
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

  // If nothing was logged this session, print push status if relevant and exit
  if (entries.length === 0) {
    if (gitStatus === 'pushed') {
      process.stdout.write('UpToCode: ✓ Saved to GitHub\n');
    }
    process.exit(0);
  }

  // ── Session had activity — run full inspection and show report ────────────
  const allViolations = violationEntries.flatMap(e => e.violations);
  const flaggedFiles = new Set(violationEntries.map(e => e.file));
  const resolvedFiles = new Set(cleanEntries.map(e => e.file).filter(f => flaggedFiles.has(f)));
  const openFiles = [...flaggedFiles].filter(f => !resolvedFiles.has(f));

  const inspectionResult = runInspection(manifest, projectRoot);

  const report = renderInspectionReport(inspectionResult, {
    sessionViolations: allViolations.length,
    sessionFixed: resolvedFiles.size,
    gitStatus: gitStatus === 'up_to_date' ? 'pushed' : gitStatus as 'pushed' | 'no_remote' | 'push_failed',
    remote: remote ?? undefined,
  });

  process.stdout.write(report);

  // Update last-report timestamp
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(lastReportPath, new Date().toISOString(), 'utf-8');
  } catch { /* non-fatal */ }

  process.exit(openFiles.length > 0 ? 2 : 0);
}

main();
