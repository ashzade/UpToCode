#!/usr/bin/env ts-node
/**
 * UpToCode PostToolUse hook.
 *
 * Fires after every Edit/Write. If the changed file is a code file (.py/.ts/.js),
 * runs contract-diff against the nearest manifest.json and reports violations back
 * to Claude (exit 2 = feedback shown to Claude in the same turn).
 *
 * If the changed file is requirements.md, re-runs compile-spec automatically.
 *
 * Exit codes:
 *   0 = clean (no output shown to Claude)
 *   2 = violations found (stdout shown to Claude as feedback)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from './src/index';
import { contractDiff } from './src/diff-engine/index';
import { CodeFile } from './src/diff-engine/types';
import { Manifest } from './src/types';

// ── Read hook input from stdin ───────────────────────────────────────────────

function readStdin(): string {
  try {
    return fs.readFileSync('/dev/stdin', 'utf-8');
  } catch {
    return '';
  }
}

interface HookInput {
  tool_name: string;
  tool_input: {
    file_path?: string;
    [key: string]: unknown;
  };
}

// ── Find nearest manifest.json ───────────────────────────────────────────────

function findManifest(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'manifest.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  // ── requirements.md changed → re-compile spec ───────────────────────────
  if (basename === 'requirements.md') {
    if (!fs.existsSync(filePath)) process.exit(0);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const manifest = parse(content);
      const manifestPath = path.join(path.dirname(filePath), 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      // Exit 0 — silently recompile, don't interrupt Claude's flow
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`UpToCode: requirements.md parse error — ${msg}\n`);
      process.exit(2);
    }
  }

  // ── Code file changed → run contract-diff ───────────────────────────────
  if (!['.py', '.ts', '.js'].includes(ext)) process.exit(0);
  if (!fs.existsSync(filePath)) process.exit(0);

  const manifestPath = findManifest(path.dirname(filePath));
  if (!manifestPath) process.exit(0); // No manifest in tree — not an uptocode project

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    process.exit(0);
  }

  const files: CodeFile[] = [{
    path: filePath,
    content: fs.readFileSync(filePath, 'utf-8'),
  }];

  const result = contractDiff(manifest, files);

  if (result.violations.length === 0) process.exit(0);

  // Format violations for Claude
  const lines: string[] = [
    `UpToCode: ${result.violations.length} rule violation(s) in ${path.basename(filePath)}`,
  ];
  for (const v of result.violations) {
    const loc = v.location ? `:${v.location.line}` : '';
    lines.push(`  ${v.ruleId} [${v.severity}]${loc} — ${v.title}`);
    if (v.fixHint) lines.push(`    Fix: ${v.fixHint}`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(2);
}

main().catch(() => process.exit(0));
