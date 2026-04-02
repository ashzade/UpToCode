import { CodeFile } from '../diff-engine/types';
import { CoherenceIssue } from './types';

/** Files that are entry points and should never be flagged as dead. */
const ENTRY_POINT_NAMES = new Set([
  'index.ts', 'index.tsx', 'index.js',
  'route.ts', 'route.tsx',
  'page.tsx', 'page.ts',
  'layout.tsx', 'layout.ts',
  'middleware.ts', 'middleware.js',
]);

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__/;

/**
 * Extract named exports from a file's content.
 * Matches: export function Foo, export const Foo, export class Foo,
 *          export type Foo, export interface Foo
 */
function extractExports(content: string): string[] {
  const names: string[] = [];
  const re = /\bexport\s+(?:default\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Extract all import specifiers from a file's content.
 * Returns individual named imports { Foo, Bar } → ['Foo', 'Bar']
 * and default imports (import Foo from ...) → ['Foo']
 */
function extractImportedNames(content: string): Set<string> {
  const names = new Set<string>();

  // Named imports: import { Foo, Bar as Baz } from '...'
  const namedRe = /import\s+(?:type\s+)?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      // Handle "Foo as Bar" — the local name is Bar
      const aliasMatch = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        names.add(aliasMatch[1]); // original name
        names.add(aliasMatch[2]); // local alias
      } else {
        const name = part.trim().replace(/^type\s+/, '');
        if (name) names.add(name);
      }
    }
  }

  // Default imports: import Foo from '...'
  const defaultRe = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
  while ((m = defaultRe.exec(content)) !== null) {
    names.add(m[1]);
  }

  // Namespace imports: import * as Foo from '...'
  const namespaceRe = /import\s+\*\s+as\s+(\w+)\s+from/g;
  while ((m = namespaceRe.exec(content)) !== null) {
    names.add(m[1]);
  }

  return names;
}

/**
 * Extract all module paths that appear in import-from statements.
 * Returns bare paths as written in source (e.g. './lib/utils', '../types').
 */
function extractImportedPaths(content: string): Set<string> {
  const paths = new Set<string>();
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    paths.add(m[1]);
  }
  // Also catch require()
  const req = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = req.exec(content)) !== null) {
    paths.add(m[1]);
  }
  return paths;
}

/**
 * Normalise a file path for comparison against import paths.
 * Returns variants that an importer might use (with/without extension,
 * with/without /index suffix).
 */
function importPathVariants(filePath: string): string[] {
  // Strip extension
  const noExt = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
  // Strip trailing /index
  const noIndex = noExt.endsWith('/index') ? noExt.slice(0, -6) : noExt;
  return [filePath, noExt, noIndex];
}

export function detectDeadCode(files: CodeFile[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];

  // Only analyse TS/TSX files
  const tsFiles = files.filter(f => /\.(ts|tsx)$/.test(f.path) && !TEST_FILE_RE.test(f.path));

  // Build set of all imported names across the whole codebase
  const allImportedNames = new Set<string>();
  const allImportedPaths = new Set<string>();

  for (const f of files) {
    for (const name of extractImportedNames(f.content)) allImportedNames.add(name);
    for (const p of extractImportedPaths(f.content)) allImportedPaths.add(p);
  }

  // ── 1. Dead exports ──────────────────────────────────────────────────────
  for (const file of tsFiles) {
    const exports = extractExports(file.content);
    for (const name of exports) {
      if (name === 'default') continue;
      if (!allImportedNames.has(name)) {
        const lines = file.content.split('\n');
        const lineIdx = lines.findIndex(l =>
          new RegExp(`\\bexport\\b.*\\b${name}\\b`).test(l)
        );
        issues.push({
          id: 'dead-export',
          severity: 'MEDIUM',
          file: file.path,
          line: lineIdx >= 0 ? lineIdx + 1 : undefined,
          message: `Dead export: '${name}' is exported but never imported`,
          detail: `The symbol '${name}' in ${file.path} is exported but does not appear in any import statement across the project.`,
          fixHint: `Remove the export keyword from '${name}', or delete the symbol if it is truly unused.`,
        });
      }
    }
  }

  // ── 2. Dead files ────────────────────────────────────────────────────────
  for (const file of tsFiles) {
    const basename = file.path.split('/').pop() ?? '';
    if (ENTRY_POINT_NAMES.has(basename)) continue;

    const variants = importPathVariants(file.path);
    const isImported = [...allImportedPaths].some(importedPath => {
      return variants.some(v => {
        // Exact match or suffix match (relative import resolving to absolute path)
        if (v === importedPath) return true;
        if (v.endsWith(importedPath)) return true;
        if (importedPath.endsWith(v)) return true;
        // Match last segments (relative imports like './utils' vs 'src/utils')
        const importedSegs = importedPath.replace(/\\/g, '/').split('/');
        const fileSegs = v.replace(/\\/g, '/').split('/');
        const minLen = Math.min(importedSegs.length, fileSegs.length);
        if (minLen >= 2) {
          return importedSegs.slice(-minLen).join('/') === fileSegs.slice(-minLen).join('/');
        }
        return importedSegs[importedSegs.length - 1] === fileSegs[fileSegs.length - 1];
      });
    });

    if (!isImported) {
      issues.push({
        id: 'dead-file',
        severity: 'LOW',
        file: file.path,
        message: `Dead file: ${basename} is never imported`,
        detail: `The file ${file.path} does not appear in any import statement across the project. It may be leftover from a refactor.`,
        fixHint: `Delete this file if it is no longer needed, or import it from the appropriate entry point.`,
      });
    }
  }

  return issues;
}
