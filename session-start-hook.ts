#!/usr/bin/env ts-node
/**
 * UpToCode UserPromptSubmit hook — session-start drift check.
 *
 * Fires when the user submits a message to Claude. Runs a quick
 * check to detect if the codebase has drifted from the spec since
 * the last session — catches work done outside Claude (direct edits,
 * migrations, other tools).
 *
 * Debounced: only runs once per 10 minutes to avoid spamming on
 * every message in an active session.
 *
 * Exit codes:
 *   0 = clean, or debounced (no output)
 *   2 = drift detected (warning shown to Claude before responding)
 */

import * as fs from 'fs';
import * as path from 'path';
import { contractDiff } from './src/diff-engine/index';
import { CodeFile } from './src/diff-engine/types';
import { Manifest } from './src/types';

const DEBOUNCE_MINUTES = 2;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);

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

function walkCodeFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) results.push(...walkCodeFiles(full));
      else if (entry.isFile() && /\.(py|ts|tsx|js)$/.test(entry.name)) results.push(full);
    }
  } catch { /* non-fatal */ }
  return results;
}

function shouldRun(projectRoot: string): boolean {
  const stampPath = path.join(projectRoot, '.uptocode', 'last_drift_check');
  if (!fs.existsSync(stampPath)) return true;
  try {
    const last = new Date(fs.readFileSync(stampPath, 'utf-8').trim());
    const minutesAgo = (Date.now() - last.getTime()) / 60000;
    return minutesAgo >= DEBOUNCE_MINUTES;
  } catch {
    return true;
  }
}

function writeStamp(projectRoot: string): void {
  try {
    const dir = path.join(projectRoot, '.uptocode');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last_drift_check'), new Date().toISOString(), 'utf-8');
  } catch { /* non-fatal */ }
}

function main() {
  const projectRoot = findProjectRoot();
  if (!projectRoot) process.exit(0);

  if (!shouldRun(projectRoot)) process.exit(0);
  writeStamp(projectRoot);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf-8'));
  } catch {
    process.exit(0);
  }

  const codeFiles: CodeFile[] = walkCodeFiles(projectRoot).map(p => ({
    path: p,
    content: fs.readFileSync(p, 'utf-8'),
  }));

  if (codeFiles.length === 0) process.exit(0);

  const result = contractDiff(manifest, codeFiles);

  if (result.violations.length === 0) process.exit(0);

  // Only surface HIGH/CRITICAL at session start — avoid noise from MEDIUM/LOW
  const critical = result.violations.filter(v => v.severity === 'CRITICAL' || v.severity === 'HIGH');
  if (critical.length === 0) process.exit(0);

  const lines = [
    `UpToCode: ⚠️ ${critical.length} unresolved violation(s) detected — your code may have drifted from your spec outside this session.`,
  ];
  for (const v of critical.slice(0, 3)) {
    const loc = v.location ? ` (${path.relative(projectRoot, v.location.file)}:${v.location.line})` : '';
    lines.push(`  ${v.ruleId} [${v.severity}]${loc} — ${v.title}`);
  }
  if (critical.length > 3) lines.push(`  ...and ${critical.length - 3} more.`);
  lines.push(`  Say "Fix spec violations" to resolve them before continuing.`);

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(2);
}

main();
