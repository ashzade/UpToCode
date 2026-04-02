import { CodeFile } from '../diff-engine/types';
import { CoherenceIssue } from './types';

/**
 * Returns true if the catch body is "meaningful" — i.e., it rethrows,
 * returns an error response, or calls a response method.
 */
function isMeaningfulCatchBody(body: string): boolean {
  // Rethrow
  if (/\bthrow\b/.test(body)) return true;
  // NextResponse error return
  if (/\bNextResponse\b/.test(body)) return true;
  // Express / Koa response
  if (/\bres\.status\s*\(/.test(body)) return true;
  // Reject a promise
  if (/\breject\s*\(/.test(body)) return true;
  // Return with an error value (return new Error, return null, etc.)
  if (/\breturn\b/.test(body)) return true;
  return false;
}

/**
 * Extract lines of a try-catch block starting at the line that opens the
 * catch clause. Returns the catch body lines (between the braces).
 */
function extractCatchBody(lines: string[], catchLineIdx: number): string {
  let depth = 0;
  let started = false;
  const bodyLines: string[] = [];

  for (let i = catchLineIdx; i < lines.length && bodyLines.length < 50; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }
    if (started) bodyLines.push(line);
    if (started && depth === 0) break;
  }

  return bodyLines.join('\n');
}

/**
 * Returns true if the try body (from the try keyword to the matching })
 * contains a call to a validate* function.
 */
function tryBodyHasValidation(lines: string[], tryLineIdx: number): boolean {
  let depth = 0;
  let started = false;
  const VALIDATE_RE = /\bvalidate[A-Z]\w*\s*\(/;

  for (let i = tryLineIdx; i < lines.length && i < tryLineIdx + 100; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }
    if (started && VALIDATE_RE.test(line)) return true;
    if (started && depth === 0) break;
  }

  return false;
}

export function detectSilentCatches(files: CodeFile[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];

  // Catch-clause patterns: catch {, catch (e) {, catch (err) {, catch (error) {
  const CATCH_RE = /\bcatch\s*(?:\(\s*\w*\s*\))?\s*\{/;

  for (const file of files) {
    if (!/\.(ts|tsx|js)$/.test(file.path)) continue;

    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Find try blocks
      if (!/\btry\s*\{/.test(line)) continue;

      // Check if this try body contains a validateXxx call
      if (!tryBodyHasValidation(lines, i)) continue;

      // Find the corresponding catch
      let depth = 0;
      let started = false;
      let catchLineIdx = -1;

      for (let j = i; j < lines.length && j < i + 200; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          if (ch === '}') depth--;
        }
        if (started && depth === 0) {
          // Next non-empty line after try body closing brace should be catch
          for (let k = j + 1; k < lines.length && k < j + 5; k++) {
            if (CATCH_RE.test(lines[k])) {
              catchLineIdx = k;
              break;
            }
            if (lines[k].trim() !== '') break;
          }
          break;
        }
      }

      if (catchLineIdx < 0) continue;

      const catchBody = extractCatchBody(lines, catchLineIdx);

      if (!isMeaningfulCatchBody(catchBody)) {
        issues.push({
          id: 'silent-catch',
          severity: 'HIGH',
          file: file.path,
          line: i + 1,
          message: `Silent catch swallows validation error at line ${i + 1}`,
          detail:
            `A try block containing a validate*() call at line ${i + 1} has a catch that does not rethrow, ` +
            `return a NextResponse error, or call res.status(). The validation contract is silently voided.`,
          fixHint:
            `Add error handling to the catch block: rethrow the error, return NextResponse.json({ error: e.message }, { status: 400 }), ` +
            `or call res.status(400).json({ error }) to surface validation failures to callers.`,
        });
      }
    }
  }

  return issues;
}
