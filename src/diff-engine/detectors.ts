import { Manifest, Rule, EnforcementDirective } from '../types';
import { CodeFile, CodeIndex, Violation } from './types';

/**
 * Extract meaningful searchable tokens from a predicate condition string.
 *
 * "actor.type == 'AuthenticatedUser' AND Session.created_at > NOW() - INTERVAL(30, minutes)"
 * → ['AuthenticatedUser', 'Session', 'created_at', '30', 'minutes']
 *
 * "env(ANTHROPIC_API_KEY) != '' AND entity.status == 'pending'"
 * → envTerms: ['ANTHROPIC_API_KEY'], fieldTerms: ['status', 'pending']
 *
 * Strips: operators (==, !=, >, <, AND, OR, NOT), function calls (NOW()), prefixes (actor., entity.)
 */
export function extractConditionTerms(condition: string): string[] {
  // Remove function calls like NOW()
  let s = condition.replace(/\bNOW\(\)/gi, '');

  // Remove INTERVAL(...) but keep its args
  s = s.replace(/\bINTERVAL\s*\(/gi, '(');

  // Remove env() wrapper but keep the var name (e.g. env(ANTHROPIC_API_KEY) → ANTHROPIC_API_KEY)
  s = s.replace(/\benv\(([^)]+)\)/gi, '$1');

  // Remove entity./actor. prefixes
  s = s.replace(/\b(entity|actor)\./gi, '');

  // Tokenize: split on whitespace, operators, parentheses, commas
  const tokens = s.split(/[\s=!<>(),+\-*/]+/).filter(Boolean);

  const stopWords = new Set([
    'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE',
    'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false',
    '', "'", '"'
  ]);

  const results: string[] = [];
  for (const token of tokens) {
    // Remove surrounding quotes
    const clean = token.replace(/^['"]|['"]$/g, '');
    if (clean.length === 0) continue;
    if (stopWords.has(clean)) continue;
    // Skip pure operators
    if (/^[=><!]+$/.test(clean)) continue;
    results.push(clean);
  }

  // Deduplicate while preserving order
  return [...new Set(results)];
}

/**
 * Extract env var names from env() calls in a condition.
 * env(ANTHROPIC_API_KEY) → ['ANTHROPIC_API_KEY']
 */
export function extractEnvTerms(condition: string): string[] {
  const matches = [...condition.matchAll(/\benv\(([^)]+)\)/gi)];
  return matches.map(m => m[1].trim());
}

/** Detect language from file extension. */
function detectLanguage(filePath: string): 'python' | 'ts-js' {
  return filePath.endsWith('.py') ? 'python' : 'ts-js';
}

/**
 * Find the line numbers (1-based) of handler entry points in a file.
 * For Python: `def funcname():` at module level (indent = 0).
 * For TS/JS: Express router.method() calls.
 */
function findHandlerLines(lines: string[], language: 'python' | 'ts-js'): number[] {
  const result: number[] = [];
  if (language === 'python') {
    for (let i = 0; i < lines.length; i++) {
      // Top-level def (no leading whitespace)
      if (/^def\s+\w+\s*\(/.test(lines[i])) {
        result.push(i + 1);
      }
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (
        /\b(router|app)\.(get|post|put|patch|delete|use)\s*\(/.test(lines[i]) ||
        /\basync\s+function\s+\w+/.test(lines[i]) ||
        /\bexport\s+(default\s+)?function/.test(lines[i])
      ) {
        result.push(i + 1);
      }
    }
  }
  return result;
}

/**
 * Extract the body of a handler starting at handlerLineIdx (0-based).
 * Python: indentation-based; TS/JS: brace-depth-based.
 */
function extractHandlerBodyLang(
  lines: string[],
  handlerLineIdx: number,
  language: 'python' | 'ts-js'
): string {
  if (language === 'python') {
    return extractPythonFunctionBody(lines, handlerLineIdx);
  }
  return extractHandlerBody(lines, handlerLineIdx);
}

/**
 * Extract a Python function body by indentation.
 * Collects lines more-indented than the `def` line until indentation returns
 * to the same level or less (or EOF).
 */
function extractPythonFunctionBody(lines: string[], defLineIdx: number): string {
  const bodyLines: string[] = [lines[defLineIdx]];
  const defIndent = lines[defLineIdx].search(/\S/);

  for (let i = defLineIdx + 1; i < lines.length && bodyLines.length < 150; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      bodyLines.push(line);
      continue;
    }
    const lineIndent = line.search(/\S/);
    if (lineIndent <= defIndent) break;
    bodyLines.push(line);
  }
  return bodyLines.join('\n');
}

/**
 * Strip SQL string literals from a code body so SQL WHERE/AND clauses
 * don't get mistaken for Python-level guards.
 * Removes content inside triple-quoted and single-quoted SQL strings.
 */
function stripSqlStrings(body: string): string {
  // Remove triple-quoted strings (Python SQL blocks: """ ... """)
  return body.replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''");
}

/**
 * Check whether the body of a function contains a guard on the given term.
 * Language-aware: Python uses `if term`, `if not term`, `raise`, `abort`;
 * TS/JS uses `if (`, `===`, `!==`.
 */
function hasGuardOnTerm(body: string, term: string, language: 'python' | 'ts-js'): boolean {
  const escaped = escapeRegex(term);
  const cleanBody = language === 'python' ? stripSqlStrings(body) : body;
  if (language === 'python') {
    return (
      new RegExp(`if\\s+(not\\s+)?${escaped}`, 'i').test(cleanBody) ||
      new RegExp(`if\\s+.*${escaped}`, 'i').test(cleanBody) ||
      new RegExp(`${escaped}\\s+is\\s+(None|not None)`, 'i').test(cleanBody) ||
      /\braise\b/.test(cleanBody) ||
      /\babort\s*\(/.test(cleanBody)
    );
  }
  return (
    new RegExp(`if\\s*\\(.*${escaped}`, 'i').test(cleanBody) ||
    new RegExp(`${escaped}.*===`, 'i').test(cleanBody) ||
    new RegExp(`${escaped}.*==`, 'i').test(cleanBody)
  );
}

/**
 * Check whether the file (or codebase via index) shows evidence that an env var
 * is accessed and guarded. Searches beyond single function bodies.
 *
 * Patterns (Python): os.getenv('VAR'), os.environ.get('VAR'), os.environ['VAR'],
 *   VAR = os.getenv(...), if not VAR, if VAR is None, from config import VAR
 */
function hasEnvVarAccess(varName: string, fileContent: string): boolean {
  const escaped = escapeRegex(varName);
  const patterns = [
    new RegExp(`os\\.getenv\\(['"]\s*${escaped}\s*['"]`, 'i'),
    new RegExp(`os\\.environ\\.get\\(['"]\s*${escaped}\s*['"]`, 'i'),
    new RegExp(`os\\.environ\\[['"]\s*${escaped}\s*['"]\]`, 'i'),
    new RegExp(`${escaped}\\s*=\\s*os\\.getenv`, 'i'),
    new RegExp(`${escaped}\\s*=\\s*os\\.environ`, 'i'),
    new RegExp(`if\\s+(not\\s+)?${escaped}\\b`, 'i'),
    new RegExp(`${escaped}\\s+is\\s+(None|not None)`, 'i'),
    new RegExp(`from\\s+config\\s+import.*\\b${escaped}\\b`, 'i'),
    new RegExp(`process\\.env\\.${escaped}`, 'i'),             // Node.js
    new RegExp(`process\\.env\\[['"]${escaped}['"]\\]`, 'i'),  // Node.js bracket
  ];
  return patterns.some(p => p.test(fileContent));
}

/**
 * Get scope targets from a rule. The Manifest Rule type doesn't have a scope field
 * in the base types.ts, but the manifest JSON may include one at runtime.
 * We use a type assertion to access it if present.
 */
function getRuleScope(rule: Rule): string[] {
  const r = rule as Rule & { scope?: string[] };
  return r.scope || [];
}

/**
 * Resolve scope targets to candidate files. If no scope targets, returns all files.
 */
function getCandidateFiles(
  scopeTargets: string[],
  files: CodeFile[],
  index: CodeIndex
): Array<{ file: string; line: number }> {
  if (scopeTargets.length === 0) {
    return files.map(f => ({ file: f.path, line: 1 }));
  }

  const matches: Array<{ file: string; line: number }> = [];
  for (const target of scopeTargets) {
    const resolved = index.resolve(target);
    matches.push(...resolved);
  }

  // Deduplicate by file path
  const seen = new Set<string>();
  return matches.filter(m => {
    if (seen.has(m.file)) return false;
    seen.add(m.file);
    return true;
  });
}

/**
 * Find the line number of a route handler definition in the given file content.
 * Returns null if not found.
 */
function findRouteHandlerLine(
  content: string,
  filePath: string
): number | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match Express route definitions: router.get/post/put/patch/delete/use
    if (/\b(router|app)\.(get|post|put|patch|delete|use)\s*\(/.test(line)) {
      return i + 1;
    }
    // Also match direct function declarations that handle routes
    if (/\basync\s+function\s+\w+/.test(line) || /\bexport\s+(default\s+)?function/.test(line)) {
      return i + 1;
    }
  }
  return null;
}

/**
 * Detect security violations for a given rule.
 * Strategy: extract condition terms and check if they appear in the handler code.
 * If a handler exists but key terms are absent → violation.
 */
export function detectSecurityViolation(
  rule: Rule,
  enforcement: EnforcementDirective,
  candidates: Array<{ file: string; line: number }>,
  files: CodeFile[],
  index: CodeIndex
): Violation | null {
  const conditionTerms = extractConditionTerms(rule.condition);
  const envTerms = extractEnvTerms(rule.condition);

  // Terms that are critical indicators (not just actor types)
  const criticalTerms = conditionTerms.filter(t => {
    if (/^[A-Z][a-zA-Z]+User$/.test(t) || t === 'System') return false;
    return true;
  });

  // If condition is entirely about env vars, use env-var access check instead
  if (envTerms.length > 0 && criticalTerms.every(t => envTerms.includes(t))) {
    return detectEnvVarViolation(rule, enforcement, candidates, index);
  }

  for (const candidate of candidates) {
    const fileContent = index.getFile(candidate.file);
    if (!fileContent) continue;

    const lang = detectLanguage(candidate.file);
    const lines = fileContent.split('\n');
    const handlerLines = findHandlerLines(lines, lang);

    if (handlerLines.length === 0) continue;

    for (const handlerLine of handlerLines) {
      const handlerBody = extractHandlerBodyLang(lines, handlerLine - 1, lang);

      const missingTerms = criticalTerms.filter(term => {
        const variants = [term, term.toLowerCase(), toCamelCase(term.toLowerCase()), toSnakeCase(term)];
        return !variants.some(v => handlerBody.toLowerCase().includes(v.toLowerCase()));
      });

      if (missingTerms.length > 0 && criticalTerms.length > 0) {
        const responses = enforcement.responses.map(r => r.action);
        return {
          ruleId: rule.id,
          severity: enforcement.severity,
          title: rule.title,
          description: buildViolationDescription(rule, candidate.file, handlerLine),
          scopeTargets: getRuleScope(rule),
          location: { file: candidate.file, line: handlerLine },
          condition: rule.condition,
          fixHint: buildFixHint(rule),
          enforcement: { responses },
        };
      }
    }
  }

  return null;
}

/**
 * Detect business rule violations.
 * Strategy: look for the entity field referenced in the condition and check
 * if there's a conditional check on that field before the main operation.
 */
export function detectBusinessViolation(
  rule: Rule,
  enforcement: EnforcementDirective,
  candidates: Array<{ file: string; line: number }>,
  files: CodeFile[],
  index: CodeIndex
): Violation | null {
  const conditionTerms = extractConditionTerms(rule.condition);
  const envTerms = extractEnvTerms(rule.condition);

  // Field terms: snake_case or lowercase identifiers (excludes env var names)
  const fieldTerms = conditionTerms.filter(t =>
    (t.includes('_') || /^[a-z]/.test(t)) && !envTerms.includes(t)
  );

  // env() terms are the primary guard — if env var is accessed the rule is satisfied.
  // Don't fall through to field-term check; entity.field references in env-guarded
  // conditions are contextual qualifiers, not independent guards to enforce.
  if (envTerms.length > 0) {
    return detectEnvVarViolation(rule, enforcement, candidates, index);
  }

  for (const candidate of candidates) {
    const fileContent = index.getFile(candidate.file);
    if (!fileContent) continue;

    const lang = detectLanguage(candidate.file);
    const lines = fileContent.split('\n');
    const handlerLines = findHandlerLines(lines, lang);

    if (handlerLines.length === 0) continue;

    for (const handlerLine of handlerLines) {
      const handlerBody = extractHandlerBodyLang(lines, handlerLine - 1, lang);
      // Strip SQL string literals so column names inside SQL queries
      // don't trigger false positives — only look at Python code lines.
      const codeBody = lang === 'python' ? stripSqlStrings(handlerBody) : handlerBody;

      // Word-boundary match so 'processed' doesn't match 'processed_at'.
      const termsPresent = fieldTerms.some(term =>
        new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(codeBody)
      );

      if (termsPresent) {
        const hasGuard = fieldTerms.some(term =>
          hasGuardOnTerm(codeBody, term, lang)
        );

        if (!hasGuard) {
          const responses = enforcement.responses.map(r => r.action);
          return {
            ruleId: rule.id,
            severity: enforcement.severity,
            title: rule.title,
            description: buildViolationDescription(rule, candidate.file, handlerLine),
            scopeTargets: getRuleScope(rule),
            location: { file: candidate.file, line: handlerLine },
            condition: rule.condition,
            fixHint: buildFixHint(rule),
            enforcement: { responses },
          };
        }
      }
    }
  }

  return null;
}

/**
 * Detect validation violations.
 * Check if validation for the referenced field exists in the handler.
 */
export function detectValidationViolation(
  rule: Rule,
  enforcement: EnforcementDirective,
  candidates: Array<{ file: string; line: number }>,
  files: CodeFile[],
  index: CodeIndex
): Violation | null {
  const conditionTerms = extractConditionTerms(rule.condition);
  const envTerms = extractEnvTerms(rule.condition);

  if (envTerms.length > 0) {
    return detectEnvVarViolation(rule, enforcement, candidates, index);
  }

  const fieldTerms = conditionTerms.filter(t => !envTerms.includes(t));

  for (const candidate of candidates) {
    const fileContent = index.getFile(candidate.file);
    if (!fileContent) continue;

    const lang = detectLanguage(candidate.file);
    const lines = fileContent.split('\n');
    const handlerLines = findHandlerLines(lines, lang);

    if (handlerLines.length === 0) continue;

    for (const handlerLine of handlerLines) {
      const handlerBody = extractHandlerBodyLang(lines, handlerLine - 1, lang);
      const codeBody = lang === 'python' ? stripSqlStrings(handlerBody) : handlerBody;

      for (const term of fieldTerms) {
        if (new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(codeBody)) {
          const hasValidation = lang === 'python'
            ? (
                /\bif\s/.test(codeBody) ||
                /\bif\s+not\s/.test(codeBody) ||
                /\braise\b/.test(codeBody) ||
                /\babort\s*\(/.test(codeBody) ||
                /\bassert\b/.test(codeBody) ||
                /\.strip\(\)/.test(codeBody) ||
                /\blen\s*\(/.test(codeBody)
              )
            : (
                /\.length/.test(codeBody) ||
                /!==\s*['"]/.test(codeBody) ||
                /===\s*['"]/.test(codeBody) ||
                /\.test\(/.test(codeBody) ||
                /if\s*\(!/.test(codeBody) ||
                /if\s*\(/.test(codeBody)
              );

          if (!hasValidation) {
            const responses = enforcement.responses.map(r => r.action);
            return {
              ruleId: rule.id,
              severity: enforcement.severity,
              title: rule.title,
              description: buildViolationDescription(rule, candidate.file, handlerLine),
              scopeTargets: getRuleScope(rule),
              location: { file: candidate.file, line: handlerLine },
              condition: rule.condition,
              fixHint: buildFixHint(rule),
              enforcement: { responses },
            };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Detect env var violations: check whether ALL env var names from the condition
 * are accessed (guarded) somewhere in the candidate files.
 * Returns a violation if ANY env var is missing from all candidate files.
 */
function detectEnvVarViolation(
  rule: Rule,
  enforcement: EnforcementDirective,
  candidates: Array<{ file: string; line: number }>,
  index: CodeIndex
): Violation | null {
  const envTerms = extractEnvTerms(rule.condition);
  if (envTerms.length === 0) return null;

  for (const varName of envTerms) {
    // Check if any candidate file accesses this env var
    const anyFileHasAccess = candidates.some(candidate => {
      const fileContent = index.getFile(candidate.file);
      return fileContent ? hasEnvVarAccess(varName, fileContent) : false;
    });

    if (!anyFileHasAccess) {
      // Also check all files (not just candidates) — env var might be in config
      const allFiles = candidates; // callers restrict to candidates; full scan done in index
      const responses = enforcement.responses.map(r => r.action);
      return {
        ruleId: rule.id,
        severity: enforcement.severity,
        title: rule.title,
        description:
          `Rule ${rule.id} (${rule.title}): no guard for env var '${varName}' found in scanned files. ` +
          `Expected patterns: os.getenv('${varName}'), if not ${varName}, or process.env.${varName}.`,
        scopeTargets: getRuleScope(rule),
        location: { file: candidates[0]?.file ?? '', line: 1 },
        condition: rule.condition,
        fixHint: `Add a guard: check that ${varName} is set before executing the operation. ` +
          `Python: if not os.getenv('${varName}'): raise/return. Node: if (!process.env.${varName}) throw/return.`,
        enforcement: { responses },
      };
    }
  }

  return null;
}

/**
 * Extract handler body text from a file's lines array, starting at handlerLineIdx (0-based).
 * Returns the text from the handler line to the end of its arrow function body (TS/JS).
 */
function extractHandlerBody(lines: string[], handlerLineIdx: number): string {
  // Simple approach: take from handler line to next empty line or next route definition
  const bodyLines: string[] = [];
  let depth = 0;
  let started = false;

  for (let i = handlerLineIdx; i < lines.length; i++) {
    const line = lines[i];
    bodyLines.push(line);

    // Count braces to track function body depth
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') { depth--; }
    }

    // Stop when we've closed the handler body
    if (started && depth === 0) break;
    // Safety limit
    if (bodyLines.length > 100) break;
  }

  return bodyLines.join('\n');
}

function buildViolationDescription(rule: Rule, file: string, line: number): string {
  // Build a human-readable description based on the rule type and condition
  const condTerms = extractConditionTerms(rule.condition);

  if (rule.type === 'Security') {
    // Look for session/time-related terms
    const timeTerms = condTerms.filter(t =>
      ['created_at', 'minutes', 'hours', 'seconds', '30', '60'].includes(t.toLowerCase())
    );
    if (timeTerms.length > 0) {
      return `Route in ${file} does not verify that the session was created within the required time window.`;
    }
    const actorTerms = condTerms.filter(t => /^[A-Z]/.test(t) && t !== 'Session');
    if (actorTerms.length > 0) {
      return `Route in ${file} does not restrict access to actor type: ${actorTerms.join(', ')}.`;
    }
  }

  return `Rule ${rule.id} (${rule.title}) condition not satisfied in ${file} at line ${line}.`;
}

function buildFixHint(rule: Rule): string {
  const condition = rule.condition;

  // Security rule with session/time check
  if (rule.type === 'Security' && condition.includes('Session.created_at')) {
    const intervalMatch = condition.match(/INTERVAL\((\d+),\s*(\w+)\)/);
    if (intervalMatch) {
      return `Add middleware to verify Session.created_at > NOW() - INTERVAL(${intervalMatch[1]}, ${intervalMatch[2]}) before the route handler.`;
    }
  }

  if (rule.type === 'Security' && condition.includes("actor.type")) {
    const actorMatch = condition.match(/actor\.type\s*==\s*['"](\w+)['"]/);
    if (actorMatch) {
      return `Restrict this route to actor type '${actorMatch[1]}' only.`;
    }
  }

  if (rule.type === 'Business') {
    const fieldMatch = condition.match(/entity\.(\w+)/);
    if (fieldMatch) {
      return `Add a guard to check ${fieldMatch[1]} before executing the operation.`;
    }
  }

  if (rule.type === 'Validation') {
    const fieldMatch = condition.match(/entity\.(\w+)/);
    if (fieldMatch) {
      return `Validate that ${fieldMatch[1]} is not empty/null before processing.`;
    }
  }

  return `Implement the condition: ${rule.condition}`;
}

/**
 * Detect violations for all rules in the manifest.
 */
export function detectViolations(
  manifest: Manifest,
  files: CodeFile[],
  index: CodeIndex
): Violation[] {
  const violations: Violation[] = [];

  // Build enforcement map
  const enforcementMap = new Map<string, EnforcementDirective>();
  for (const directive of manifest.enforcement) {
    enforcementMap.set(directive.ruleId, directive);
  }

  for (const [ruleId, rule] of Object.entries(manifest.rules)) {
    const enforcement = enforcementMap.get(ruleId);
    if (!enforcement) continue; // Rule not in enforcement — skip

    const scopeTargets = getRuleScope(rule);
    const candidates = getCandidateFiles(scopeTargets, files, index);

    let violation: Violation | null = null;

    switch (rule.type) {
      case 'Security':
        violation = detectSecurityViolation(rule, enforcement, candidates, files, index);
        break;
      case 'Business':
        violation = detectBusinessViolation(rule, enforcement, candidates, files, index);
        break;
      case 'Validation':
        violation = detectValidationViolation(rule, enforcement, candidates, files, index);
        break;
    }

    if (violation) {
      violations.push(violation);
    }
  }

  return violations;
}

function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
