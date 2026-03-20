#!/usr/bin/env ts-node
/**
 * UpToCode Stop hook — session summary.
 *
 * Fires when Claude finishes a response. Reads the session log and prints
 * a plain-English summary of what was caught and fixed since the last report.
 *
 * Exit codes:
 *   0 = informational summary (shown to user, Claude is not re-activated)
 *   2 = unresolved violations remain (Claude re-activates to address them)
 */

import * as fs from 'fs';
import * as path from 'path';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function findLogDir(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.uptocode');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readEntries(logPath: string, since: Date): LogEntry[] {
  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
    .filter((e): e is LogEntry => e !== null && new Date(e.ts) > since);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const logDir = findLogDir();
  if (!logDir) process.exit(0);

  const logPath = path.join(logDir, 'session.jsonl');
  if (!fs.existsSync(logPath)) process.exit(0);

  const lastReportPath = path.join(logDir, 'last_report');
  const lastReport = fs.existsSync(lastReportPath)
    ? new Date(fs.readFileSync(lastReportPath, 'utf-8').trim())
    : new Date(0);

  const entries = readEntries(logPath, lastReport);
  if (entries.length === 0) process.exit(0);

  const violationEntries = entries.filter((e): e is ViolationEntry => !('clean' in e));
  if (violationEntries.length === 0) process.exit(0); // only clean runs — nothing to report

  // Tally violations
  const allViolations = violationEntries.flatMap(e => e.violations);
  const ruleCounts = new Map<string, { count: number; severity: string; title: string }>();
  for (const v of allViolations) {
    const r = ruleCounts.get(v.ruleId);
    if (r) r.count++;
    else ruleCounts.set(v.ruleId, { count: 1, severity: v.severity, title: v.title });
  }

  // Which files were flagged and then ran clean?
  const flaggedFiles = new Set(violationEntries.map(e => e.file));
  const cleanEntries = entries.filter((e): e is CleanEntry => 'clean' in e);
  const resolvedFiles = new Set(cleanEntries.map(e => e.file).filter(f => flaggedFiles.has(f)));
  const openFiles = [...flaggedFiles].filter(f => !resolvedFiles.has(f));

  // Build the report
  const out: string[] = [
    '',
    '─────────────────────────────────────',
    '  UpToCode · Session Report',
    '─────────────────────────────────────',
    `  Violations caught:  ${allViolations.length}`,
    `  Files corrected:    ${resolvedFiles.size}`,
  ];

  if (ruleCounts.size > 0) {
    out.push('');
    out.push('  Rules triggered:');
    const sorted = [...ruleCounts.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [ruleId, info] of sorted) {
      const x = info.count > 1 ? ` ×${info.count}` : '';
      out.push(`    ${ruleId} [${info.severity}]${x}  ${info.title}`);
    }
  }

  if (openFiles.length > 0) {
    out.push('');
    out.push(`  ${openFiles.length} unresolved finding(s):`);
    for (const file of openFiles) {
      const entry = [...violationEntries].reverse().find(e => e.file === file);
      if (entry) {
        for (const v of entry.violations) {
          const loc = v.line ? `:${v.line}` : '';
          out.push(`    ${file}${loc} · ${v.ruleId} — ${v.title}`);
        }
      }
    }
  }

  out.push('─────────────────────────────────────');
  out.push('');

  process.stdout.write(out.join('\n') + '\n');

  // Update the last-report timestamp
  fs.writeFileSync(lastReportPath, new Date().toISOString(), 'utf-8');

  // Exit 2 if there are unresolved violations — Claude re-activates to fix them
  process.exit(openFiles.length > 0 ? 2 : 0);
}

main();
