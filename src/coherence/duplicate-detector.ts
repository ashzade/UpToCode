import { CodeFile } from '../diff-engine/types';
import { CoherenceIssue } from './types';

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__|\btest\b/;
const MIN_STRING_LENGTH = 30;
const MIN_DUPLICATE_COUNT = 3;

/**
 * Extract string literals longer than MIN_STRING_LENGTH from a file.
 * Focuses on URL-like strings, error messages, and query strings.
 * Returns { value, line } pairs.
 */
function extractLongStrings(content: string): Array<{ value: string; line: number }> {
  const results: Array<{ value: string; line: number }> = [];
  const lines = content.split('\n');

  // Match single or double quoted strings (not template literals — too complex)
  const STRING_RE = /['"]([^'"\\]{30,})['"]/g;

  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    STRING_RE.lastIndex = 0;
    while ((m = STRING_RE.exec(lines[i])) !== null) {
      const value = m[1];
      // Focus on meaningful strings: URLs, error messages, SQL fragments
      if (
        value.startsWith('http') ||
        value.startsWith('/api') ||
        value.startsWith('/') ||
        value.toLowerCase().includes('error') ||
        value.toLowerCase().includes('select ') ||
        value.toLowerCase().includes('insert ') ||
        value.toLowerCase().includes('failed') ||
        value.includes('?') ||
        value.includes('=')
      ) {
        results.push({ value, line: i + 1 });
      }
    }
  }

  return results;
}

/**
 * Simple hash for a function body: normalise whitespace and return a
 * sorted fingerprint of method calls (word(  patterns).
 */
function hashFunctionBody(body: string): string {
  // Extract all method-call tokens: foo.bar( or barBaz(
  const calls: string[] = [];
  const CALL_RE = /\b(\w+(?:\.\w+)?)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(body)) !== null) {
    calls.push(m[1]);
  }
  return calls.join(',');
}

/**
 * Extract function bodies from content.
 * Simple regex-based brace-depth extraction for function declarations.
 */
function extractFunctionBodies(content: string): Array<{ hash: string; line: number; preview: string }> {
  const results: Array<{ hash: string; line: number; preview: string }> = [];
  const lines = content.split('\n');

  const FUNC_RE = /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/;

  for (let i = 0; i < lines.length; i++) {
    if (!FUNC_RE.test(lines[i])) continue;

    // Extract body via brace depth
    let depth = 0;
    let started = false;
    const bodyLines: string[] = [];

    for (let j = i; j < lines.length && bodyLines.length < 80; j++) {
      const line = lines[j];
      for (const ch of line) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }
      if (started) bodyLines.push(line);
      if (started && depth === 0) break;
    }

    if (bodyLines.length < 4) continue; // Too short to be meaningful

    const body = bodyLines.join('\n');
    const hash = hashFunctionBody(body);

    // Only consider bodies with at least 4 method calls
    const callCount = (hash.match(/,/g) ?? []).length + 1;
    if (callCount < 4) continue;

    results.push({ hash, line: i + 1, preview: lines[i].trim().slice(0, 60) });
  }

  return results;
}

export function detectDuplicates(files: CodeFile[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];

  const nonTestFiles = files.filter(f => !TEST_FILE_RE.test(f.path));

  // ── 1. Duplicate string literals ────────────────────────────────────────
  // Map: string value → list of { file, line }
  const stringOccurrences = new Map<string, Array<{ file: string; line: number }>>();

  for (const file of nonTestFiles) {
    const strings = extractLongStrings(file.content);
    for (const { value, line } of strings) {
      const existing = stringOccurrences.get(value) ?? [];
      existing.push({ file: file.path, line });
      stringOccurrences.set(value, existing);
    }
  }

  for (const [value, occurrences] of stringOccurrences) {
    if (occurrences.length < MIN_DUPLICATE_COUNT) continue;

    const locations = occurrences.slice(0, 4).map(o => `${o.file}:${o.line}`).join(', ');
    const { file, line } = occurrences[0];
    issues.push({
      id: 'duplicate-string',
      severity: 'LOW',
      file,
      line,
      message: `Duplicate string literal appears ${occurrences.length}× across the codebase`,
      detail:
        `The string '${value.slice(0, 60)}${value.length > 60 ? '...' : ''}' appears in ${occurrences.length} locations: ${locations}.`,
      fixHint:
        `Extract this string into a shared constant (e.g. in a \`lib/constants.ts\` file) and import it where needed.`,
    });
  }

  // ── 2. Duplicate logic blocks ────────────────────────────────────────────
  // Map: body hash → list of { file, line, preview }
  const bodyOccurrences = new Map<string, Array<{ file: string; line: number; preview: string }>>();

  for (const file of nonTestFiles) {
    const bodies = extractFunctionBodies(file.content);
    for (const { hash, line, preview } of bodies) {
      const existing = bodyOccurrences.get(hash) ?? [];
      existing.push({ file: file.path, line, preview });
      bodyOccurrences.set(hash, existing);
    }
  }

  for (const [, occurrences] of bodyOccurrences) {
    if (occurrences.length < 2) continue;

    const { file, line, preview } = occurrences[0];
    const locations = occurrences.slice(0, 3).map(o => `${o.file}:${o.line}`).join(', ');
    issues.push({
      id: 'duplicate-logic',
      severity: 'MEDIUM',
      file,
      line,
      message: `Near-identical function logic duplicated ${occurrences.length}× across the codebase`,
      detail:
        `Function starting with '${preview}' (line ${line}) has a near-identical call sequence in ${occurrences.length} locations: ${locations}.`,
      fixHint:
        `Extract the shared logic into a single utility function and call it from each site. ` +
        `This prevents the same bug from being fixed in one place but not others.`,
    });
  }

  return issues;
}
