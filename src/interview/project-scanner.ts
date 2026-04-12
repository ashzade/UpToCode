/**
 * Scans a project's codebase to extract UI structure and domain vocabulary
 * that isn't captured in requirements.md, for use in README generation.
 *
 * Extracts three things:
 * 1. Navigation structure — from HTML/JSX template nav blocks
 * 2. Route definitions — from Flask/Express/Next app files
 * 3. Domain vocabulary — from analysis/model/processor files
 */

import fs from 'fs';
import path from 'path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch { return ''; }
}

function truncateLines(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + '\n[... truncated]';
}

/** Find files matching any of the given basenames in the project root. */
function findFirst(projectRoot: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Find all files with the given extensions inside a directory (non-recursive). */
function listDir(dir: string, exts: string[]): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => exts.some(e => f.endsWith(e)))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

// ── Nav extraction ────────────────────────────────────────────────────────────

/**
 * Extract the first <nav> block from an HTML file.
 * Falls back to lines containing nav-label / nav-item if no <nav> tag found.
 */
function extractNavFromHtml(content: string): string {
  // Try to extract <nav>...</nav>
  const navMatch = content.match(/<nav[\s\S]*?<\/nav>/i);
  if (navMatch) return truncateLines(navMatch[0], 120);

  // Fallback: lines mentioning nav
  const navLines = content.split('\n')
    .filter(l => /nav-label|nav-item|nav-btn|showSection/i.test(l))
    .slice(0, 60);
  return navLines.join('\n');
}

/**
 * Extract nav structure from JSX/TSX files — look for <nav> or sidebar-like
 * structures, plus route/Link components.
 */
function extractNavFromJsx(content: string): string {
  const lines = content.split('\n');
  const navLines = lines.filter(l =>
    /<nav|<Link|<NavItem|href=|to="|sidebar|menuItem/i.test(l)
  ).slice(0, 80);
  return navLines.join('\n');
}

// ── Route extraction ──────────────────────────────────────────────────────────

/** Extract route definitions from a Python Flask/FastAPI file. */
function extractPythonRoutes(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/@app\.route|@bp\.route|@router\.(get|post|put|patch|delete)/i.test(line)) {
      result.push(line.trim());
      // Include the function def on the next line
      if (i + 1 < lines.length) result.push(lines[i + 1].trim());
    }
  }
  return result.slice(0, 80).join('\n');
}

/** Extract route definitions from a JS/TS Express or Next.js file. */
function extractJsRoutes(content: string): string {
  const lines = content.split('\n');
  return lines
    .filter(l => /app\.(get|post|put|patch|delete|use)\(|router\.(get|post|put|patch|delete)\(/i.test(l))
    .slice(0, 60)
    .join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ScannedContext {
  nav: string;
  routes: string;
  domain: string;
}

/**
 * Scan a project root and return extracted context strings.
 * Returns empty strings for sections it can't find.
 */
export function scanProject(projectRoot: string): ScannedContext {
  let nav = '';
  let routes = '';
  let domain = '';

  // ── Nav: check template directories ──────────────────────────
  const templateDirs = [
    path.join(projectRoot, 'templates'),
    path.join(projectRoot, 'views'),
    path.join(projectRoot, 'src', 'app'),
    path.join(projectRoot, 'src', 'pages'),
    path.join(projectRoot, 'app'),
  ];

  for (const dir of templateDirs) {
    const htmlFiles = listDir(dir, ['.html']);
    const jsxFiles = listDir(dir, ['.tsx', '.jsx']);

    // Prefer base/layout/index files
    const prioritise = (files: string[]) =>
      [...files.filter(f => /base|layout|index|main|app/i.test(path.basename(f))),
       ...files.filter(f => !/base|layout|index|main|app/i.test(path.basename(f)))];

    for (const f of prioritise(htmlFiles).slice(0, 2)) {
      const extracted = extractNavFromHtml(readFile(f));
      if (extracted) { nav += `\n\n[${path.relative(projectRoot, f)}]\n${extracted}`; break; }
    }
    for (const f of prioritise(jsxFiles).slice(0, 2)) {
      const extracted = extractNavFromJsx(readFile(f));
      if (extracted) { nav += `\n\n[${path.relative(projectRoot, f)}]\n${extracted}`; break; }
    }
    if (nav) break;
  }

  // ── Routes: main app file ─────────────────────────────────────
  const pyAppFile = findFirst(projectRoot, ['app.py', 'main.py', 'server.py', 'routes.py']);
  if (pyAppFile) {
    routes = extractPythonRoutes(readFile(pyAppFile));
  } else {
    const jsAppFile = findFirst(projectRoot, [
      'app.ts', 'app.js', 'server.ts', 'server.js', 'index.ts', 'index.js',
    ]);
    if (jsAppFile) routes = extractJsRoutes(readFile(jsAppFile));
  }

  // ── Domain vocabulary: analysis/model files ───────────────────
  const domainFile = findFirst(projectRoot, [
    'analyzer.py', 'analysis.py', 'processor.py', 'models.py',
    'schema.py', 'domain.py', 'service.py',
    'analyzer.ts', 'analysis.ts', 'models.ts', 'schema.ts',
  ]);
  if (domainFile) {
    domain = truncateLines(readFile(domainFile), 250);
  }

  return { nav, routes, domain };
}

/**
 * Format scanned context into a string suitable for inclusion in a prompt.
 * Returns empty string if nothing was found.
 */
export function formatScannedContext(ctx: ScannedContext): string {
  const parts: string[] = [];
  if (ctx.nav) parts.push(`### Navigation structure (from templates)\n${ctx.nav.trim()}`);
  if (ctx.routes) parts.push(`### API routes (from app file)\n${ctx.routes.trim()}`);
  if (ctx.domain) parts.push(`### Domain logic (from analysis/model file)\n${ctx.domain.trim()}`);
  if (parts.length === 0) return '';
  return parts.join('\n\n');
}
