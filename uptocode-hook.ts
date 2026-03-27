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
import * as crypto from 'crypto';
import { parse } from './src/index';
import { contractDiff } from './src/diff-engine/index';
import { CodeFile } from './src/diff-engine/types';
import { Manifest } from './src/types';

// ── Session logging ───────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }
function rel(root: string, file: string): string { return path.relative(root, file); }

function appendSessionLog(projectRoot: string, entry: object): void {
  try {
    const dir = path.join(projectRoot, '.uptocode');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'session.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* non-fatal */ }
}

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

// ── Provider drift detection ─────────────────────────────────────────────────

// Packages that are clearly not external service providers
const UTILITY_PACKAGES = new Set([
  // Node built-ins
  'fs', 'path', 'crypto', 'http', 'https', 'url', 'os', 'stream', 'buffer',
  'events', 'util', 'child_process', 'querystring', 'readline',
  // Web frameworks
  'express', 'fastify', 'koa', 'hapi', 'nestjs', 'next', 'nuxt',
  // Frontend
  'react', 'vue', 'angular', 'svelte', 'solid',
  // DB clients (infrastructure, not services)
  'pg', 'mysql', 'mysql2', 'sqlite3', 'mongoose', 'prisma', 'typeorm', 'knex',
  'redis', 'ioredis', 'mongodb',
  // HTTP/fetch
  'axios', 'nodefetch', 'got', 'superagent', 'undici', 'crossfetch',
  // Auth utilities (not a third-party service)
  'jsonwebtoken', 'bcrypt', 'bcryptjs', 'passport',
  // Utilities
  'lodash', 'ramda', 'underscore', 'dotenv', 'cors', 'helmet', 'morgan',
  'zod', 'yup', 'joi', 'classvalidator',
  'uuid', 'nanoid', 'shortid',
  'datefns', 'moment', 'dayjs',
  'winston', 'pino', 'bunyan', 'debug',
  'multer', 'formidable', 'busboy',
  'sharp', 'jimp',
  // Testing
  'jest', 'mocha', 'chai', 'vitest', 'supertest', 'sinon',
  // TypeScript / build
  'typescript', 'tsnode', 'esbuild', 'webpack', 'vite', 'rollup',
  // Anthropic/OpenAI (UpToCode itself uses Claude — don't flag it)
  'anthropic', 'openai',
  // Python stdlib
  'json', 'logging', 'threading', 'os', 're', 'sys', 'io', 'abc', 'ast',
  'math', 'time', 'random', 'copy', 'enum', 'glob', 'gzip', 'hashlib',
  'hmac', 'html', 'http', 'inspect', 'itertools', 'functools', 'collections',
  'contextlib', 'datetime', 'decimal', 'difflib', 'email', 'errno',
  'fractions', 'gc', 'getpass', 'gettext', 'heapq', 'importlib',
  'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'shlex', 'shutil',
  'signal', 'socket', 'sqlite3', 'stat', 'statistics', 'string',
  'struct', 'subprocess', 'tempfile', 'textwrap', 'traceback', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref',
  'xml', 'xmlrpc', 'zipfile', 'zlib',
  // Python web / common packages
  'flask', 'werkzeug', 'jinja2', 'wtforms', 'itsdangerous',
  'django', 'fastapi', 'starlette', 'uvicorn', 'gunicorn',
  'requests', 'httpx', 'aiohttp', 'urllib3',
  'sqlalchemy', 'alembic', 'peewee',
  'pydantic', 'marshmallow', 'cerberus',
  'celery', 'rq', 'dramatiq',
  'boto3', 'botocore', 'aiobotocore',
  'pandas', 'numpy', 'scipy', 'sklearn', 'matplotlib', 'seaborn', 'plotly',
  'pytest', 'unittest', 'hypothesis',
  'click', 'typer', 'argparse', 'rich', 'tqdm',
  'yaml', 'toml', 'dotenv', 'decouple',
  'watchdog', 'schedule', 'apscheduler',
  // Project-local Python modules (not external services)
  'database', 'processor', 'analyzer', 'config', 'gdocs_reader',
  'ics_reader', 'slack_reader', 'slack_dump_reader', 'people_api',
  'trust_scorer',
]);

function extractImportedPackages(content: string, filePath: string): string[] {
  const packages: string[] = [];
  const isPy = filePath.endsWith('.py');

  if (!isPy) {
    // import ... from 'pkg' / require('pkg')
    const patterns = [
      /(?:import|from)\s+['"](@[^'"./][^'"]*|[^'"./][^'"]*)['"]/g,
      /require\s*\(\s*['"](@[^'"./][^'"]*|[^'"./][^'"]*)['"]\s*\)/g,
    ];
    for (const re of patterns) {
      for (const m of content.matchAll(re)) {
        packages.push(m[1]);
      }
    }
  } else {
    for (const m of content.matchAll(/^(?:import|from)\s+([a-zA-Z][a-zA-Z0-9_.]*)/gm)) {
      packages.push(m[1]);
    }
  }

  // Filter out relative imports and path aliases (e.g. @/lib/..., ./foo, ../bar)
  return [...new Set(packages)].filter(p => !p.startsWith('@/') && !p.startsWith('./') && !p.startsWith('../'));
}

function normalizePackageName(pkg: string): string {
  // @foursquare/api → foursquare, @google-cloud/maps → googlecloud, @prisma/client → prisma
  const base = pkg.startsWith('@')
    ? pkg.slice(1).split('/')[0]  // take the scope, not the package name
    : pkg.split('/')[0];
  return base.replace(/[-_.]/g, '').toLowerCase();
}

function detectNewProviders(content: string, filePath: string, manifest: Manifest): string[] {
  const packages = extractImportedPackages(content, filePath);
  const knownProviders = Object.keys((manifest as unknown as { externalProviders?: Record<string, unknown> }).externalProviders ?? {})
    .map(p => p.replace(/[-_.]/g, '').toLowerCase());

  const newProviders: string[] = [];
  for (const pkg of packages) {
    const normalized = normalizePackageName(pkg);
    if (normalized.length < 3) continue;
    if (UTILITY_PACKAGES.has(normalized)) continue;
    // Skip if it matches (or is substring of) a known provider
    const matched = knownProviders.some(p => p.includes(normalized) || normalized.includes(p));
    if (!matched) {
      newProviders.push(pkg);
    }
  }

  return newProviders;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);

function walkCodeFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) results.push(...walkCodeFiles(full));
      else if (entry.isFile() && /\.(py|ts|js)$/.test(entry.name)) results.push(full);
    }
  } catch { /* non-fatal */ }
  return results;
}

/**
 * Find providers declared in the manifest that are no longer imported
 * anywhere in the codebase. Returns their manifest names.
 */
function detectDeadProviders(projectRoot: string, manifest: Manifest): string[] {
  const providers = Object.keys(
    (manifest as unknown as { externalProviders?: Record<string, unknown> }).externalProviders ?? {}
  );
  if (providers.length === 0) return [];

  const allFiles = walkCodeFiles(projectRoot);
  const allImports: string[] = [];
  const allContents: string[] = [];
  for (const f of allFiles) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      allImports.push(...extractImportedPackages(content, f));
      allContents.push(content.toLowerCase());
    } catch { /* skip unreadable files */ }
  }
  const normalizedImports = allImports.map(normalizePackageName);

  return providers.filter(provider => {
    const normalized = provider.replace(/[-_.]/g, '').toLowerCase();
    // Strip common suffixes to get the meaningful stem (e.g. "foursquareapi" → "foursquare")
    const stem = normalized.replace(/(api|sdk|service|client|provider)$/, '');
    // Consider alive if found in imports OR if the provider stem appears anywhere in the codebase
    // (covers fetch-based integrations that don't import an npm package)
    const inImports = normalizedImports.some(i => i.includes(normalized) || normalized.includes(i));
    const inContent = stem.length >= 4 && allContents.some(c => c.includes(stem));
    return !inImports && !inContent;
  });
}

// ── Broken import detection ───────────────────────────────────────────────────

/**
 * Resolve a relative import path to a real file on disk.
 * Returns the resolved path if found, null if missing.
 * Handles: exact path, .ts/.tsx/.js/.jsx extensions, and /index.* variants.
 */
function resolveImportPath(fromDir: string, importPath: string): string | null {
  const base = path.resolve(fromDir, importPath);

  if (fs.existsSync(base)) return base;

  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }

  for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
    if (fs.existsSync(path.join(base, idx))) return path.join(base, idx);
  }

  return null;
}

/**
 * Returns relative import paths that don't resolve to existing files.
 * Only checks relative imports (starting with . or ..) — package imports
 * are handled by the TypeScript check above.
 */
function findBrokenImports(filePath: string, content: string): string[] {
  const dir = path.dirname(filePath);
  const broken: string[] = [];
  const seen = new Set<string>();

  const patterns = [
    // import ... from './path'
    /(?:import|export)\s+(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"](\.[^'"]+)['"]/g,
    // require('./path')
    /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];

  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      const importPath = m[1];
      if (!importPath.startsWith('.') || seen.has(importPath)) continue;
      seen.add(importPath);
      if (resolveImportPath(dir, importPath) === null) {
        broken.push(importPath);
      }
    }
  }

  return broken;
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

  // ── requirements.md changed → re-compile spec + check README staleness ──
  if (basename === 'requirements.md') {
    if (!fs.existsSync(filePath)) process.exit(0);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const manifest = parse(content);
      const projectRoot = path.dirname(filePath);
      const manifestPath = path.join(projectRoot, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      // Check if README is stale
      const uptocodeDir = path.join(projectRoot, '.uptocode');
      const hashPath = path.join(uptocodeDir, 'readme_spec_hash');
      const readmePath = path.join(projectRoot, 'README.md');
      if (fs.existsSync(hashPath) && fs.existsSync(readmePath)) {
        const storedHash = fs.readFileSync(hashPath, 'utf-8').trim();
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        if (storedHash !== currentHash) {
          process.stdout.write(
            'UpToCode: your spec has changed since the README was last generated.\n' +
            '  Say "Update the README for my project" to bring it up to date.\n'
          );
          process.exit(2);
        }
      }

      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`UpToCode: requirements.md parse error — ${msg}\n`);
      process.exit(2);
    }
  }

  // ── Code file changed → run contract-diff ───────────────────────────────
  if (!['.py', '.ts', '.tsx', '.js'].includes(ext)) process.exit(0);
  if (!fs.existsSync(filePath)) process.exit(0);

  const manifestPath = findManifest(path.dirname(filePath));
  if (!manifestPath) process.exit(0); // No manifest in tree — not an uptocode project

  const projectRoot = path.dirname(manifestPath);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    process.exit(0);
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // ── TypeScript type check ─────────────────────────────────────────────────
  if (['.ts', '.tsx'].includes(ext)) {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      try {
        const { execSync } = require('child_process');
        const tsc = path.join(projectRoot, 'node_modules', '.bin', 'tsc');
        const tscCmd = fs.existsSync(tsc) ? tsc : 'npx tsc';
        execSync(`${tscCmd} --noEmit`, { cwd: projectRoot, stdio: 'pipe', timeout: 30000 });
      } catch (err: unknown) {
        const output = (err as { stdout?: Buffer }).stdout?.toString() ?? '';
        const relFile = path.relative(projectRoot, filePath);
        // Filter to errors in the edited file only
        const fileErrors = output.split('\n').filter(l =>
          l.startsWith(relFile) || l.includes(`/${relFile}`) || l.includes(`\\${relFile}`)
        );
        if (fileErrors.length > 0) {
          process.stdout.write(
            `UpToCode: TypeScript error in ${path.basename(filePath)} — fix before deploying:\n` +
            fileErrors.slice(0, 5).map(l => `  ${l}`).join('\n') + '\n'
          );
          process.exit(2);
        }
      }
    }
  }

  // ── Broken import check ───────────────────────────────────────────────────
  const broken = findBrokenImports(filePath, fileContent);
  if (broken.length > 0) {
    const plural = broken.length === 1 ? 'import' : 'imports';
    const list = broken.map(p => `  • ${p}`).join('\n');
    process.stdout.write(
      `UpToCode: ${broken.length} missing ${plural} in ${path.basename(filePath)} — ` +
      `these files don't exist yet:\n${list}\n` +
      `  Create the missing file(s) before finishing.\n`
    );
    process.exit(2);
  }

  // ── Check for new external providers not in the spec ──────────────────────
  const newProviders = detectNewProviders(fileContent, filePath, manifest);
  if (newProviders.length > 0) {
    const knownNames = Object.keys(
      (manifest as unknown as { externalProviders?: Record<string, unknown> }).externalProviders ?? {}
    );
    const knownList = knownNames.length > 0 ? ` (spec currently lists: ${knownNames.join(', ')})` : '';
    const msg =
      `UpToCode: new external provider detected — ${newProviders.map(p => `'${p}'`).join(', ')} is not in your spec${knownList}.\n` +
      `  Your requirements.md may be out of date. Say "Update my spec to reflect this change" to sync it.\n`;
    process.stdout.write(msg);
    process.exit(2);
  }

  // ── Check for providers in the spec no longer used in the codebase ────────
  const deadProviders = detectDeadProviders(projectRoot, manifest);
  if (deadProviders.length > 0) {
    process.stdout.write(
      `UpToCode: ${deadProviders.map(p => `'${p}'`).join(', ')} is declared in your spec but not imported anywhere in the codebase.\n` +
      `  This may be dead code and a stale spec reference. Say "Clean up removed providers from my spec" to remove them.\n`
    );
    process.exit(2);
  }

  const files: CodeFile[] = [{
    path: filePath,
    content: fileContent,
  }];

  const result = contractDiff(manifest, files);

  if (result.violations.length === 0) {
    appendSessionLog(projectRoot, { ts: now(), file: rel(projectRoot, filePath), clean: true });
    process.exit(0);
  }

  // Log violations for session report
  appendSessionLog(projectRoot, {
    ts: now(),
    file: rel(projectRoot, filePath),
    violations: result.violations.map(v => ({
      ruleId: v.ruleId,
      severity: v.severity,
      title: v.title,
      line: v.location?.line,
    })),
  });

  // Format violations for Claude (stdout)
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
