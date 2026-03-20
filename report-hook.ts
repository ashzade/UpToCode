#!/usr/bin/env ts-node
/**
 * UpToCode Stop hook — building inspection report + auto-save.
 *
 * Fires when Claude finishes a response. Runs the full local inspection
 * (logic, security, tests) and prints a plain-English report.
 *
 * If the project has a GitHub remote configured, it auto-commits any
 * changed files and pushes — the GitHub Action then posts the report
 * to the commit or PR automatically.
 *
 * If no remote exists, the local report is the full output, and UpToCode
 * suggests setting GitHub up.
 *
 * Exit codes:
 *   0 = all clear, or informational report shown to user
 *   2 = unresolved violations remain (Claude re-activates to fix them)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parse } from './src/index';
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

function autoCommitAndPush(projectRoot: string): 'pushed' | 'nothing_to_commit' | 'push_failed' {
  try {
    const status = execSync('git status --porcelain', { cwd: projectRoot }).toString().trim();
    if (!status) return 'nothing_to_commit';

    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    execSync(`git add -A && git commit -m "checkpoint: ${timestamp}"`, {
      cwd: projectRoot,
      shell: '/bin/bash',
      stdio: 'pipe',
    });
    execSync('git push', { cwd: projectRoot, stdio: 'pipe' });
    return 'pushed';
  } catch {
    return 'push_failed';
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

  // Only show the report if something happened this session
  if (entries.length === 0) process.exit(0);

  const allViolations = violationEntries.flatMap(e => e.violations);
  const flaggedFiles = new Set(violationEntries.map(e => e.file));
  const resolvedFiles = new Set(cleanEntries.map(e => e.file).filter(f => flaggedFiles.has(f)));
  const openFiles = [...flaggedFiles].filter(f => !resolvedFiles.has(f));

  // ── Run full inspection ────────────────────────────────────────────────────
  const inspectionResult = runInspection(manifest, projectRoot);

  // ── Auto-commit and push if remote exists ──────────────────────────────────
  const remote = getGitRemote(projectRoot);
  let gitStatus: 'pushed' | 'no_remote' | 'push_failed' = 'no_remote';
  if (remote) {
    const pushResult = autoCommitAndPush(projectRoot);
    gitStatus = pushResult === 'pushed' ? 'pushed'
      : pushResult === 'push_failed' ? 'push_failed'
      : 'no_remote'; // nothing to commit — treat as no-op
  }

  // ── Render and print the report ────────────────────────────────────────────
  const report = renderInspectionReport(inspectionResult, {
    sessionViolations: allViolations.length,
    sessionFixed: resolvedFiles.size,
    gitStatus,
    remote: remote ?? undefined,
  });

  process.stdout.write(report);

  // Update last-report timestamp
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(lastReportPath, new Date().toISOString(), 'utf-8');
  } catch { /* non-fatal */ }

  // Exit 2 if there are open violations — Claude re-activates to resolve them
  process.exit(openFiles.length > 0 ? 2 : 0);
}

main();
