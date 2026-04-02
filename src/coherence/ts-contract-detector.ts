import { CodeFile } from '../diff-engine/types';
import { CoherenceIssue } from './types';

/**
 * Extract interface definitions whose name ends in Input, Params, Request, Body, or Args.
 * Returns: { name, optionalFields, startLine }
 */
function extractInputInterfaces(content: string): Array<{
  name: string;
  optionalFields: string[];
  startLine: number;
}> {
  const results: Array<{ name: string; optionalFields: string[]; startLine: number }> = [];
  const lines = content.split('\n');

  const INTERFACE_RE = /\binterface\s+(\w+(?:Input|Params|Request|Body|Args|Options))\b/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(INTERFACE_RE);
    if (!m) continue;

    const name = m[1];
    const startLine = i + 1;

    // Collect the interface body
    let depth = 0;
    let started = false;
    const optionalFields: string[] = [];

    for (let j = i; j < lines.length && j < i + 100; j++) {
      const line = lines[j];

      for (const ch of line) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }

      if (started && depth === 1) {
        // Inside the interface body — look for optional fields (fieldName?: type)
        const fieldMatch = line.match(/^\s+(\w+)\?\s*:/);
        if (fieldMatch) {
          optionalFields.push(fieldMatch[1]);
        }
      }

      if (started && depth === 0) break;
    }

    if (optionalFields.length > 0) {
      results.push({ name, optionalFields, startLine });
    }
  }

  return results;
}

/**
 * Find a validate* function that corresponds to the interface.
 * Strategy: look for a function named validate<InterfaceBaseName> (case-insensitive stem match).
 *
 * e.g. interface SearchInput → validateSearch, validateSearchInput, validateSearchRequest
 */
function findValidatorForInterface(interfaceName: string, content: string): string | null {
  // Strip common suffixes to get the stem
  const stem = interfaceName
    .replace(/(?:Input|Params|Request|Body|Args|Options)$/, '')
    .toLowerCase();

  const VALIDATOR_RE = /\bfunction\s+(validate\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = VALIDATOR_RE.exec(content)) !== null) {
    const fnName = m[1].toLowerCase();
    if (fnName.includes(stem)) return m[1];
  }

  // Also check const validateXxx = ...
  const CONST_RE = /\bconst\s+(validate\w+)\s*=/gi;
  while ((m = CONST_RE.exec(content)) !== null) {
    const fnName = m[1].toLowerCase();
    if (fnName.includes(stem)) return m[1];
  }

  return null;
}

/**
 * Check if an optional field is treated as required inside a validator body.
 * Looks for patterns like:
 *  - requireString(o, 'fieldName')
 *  - requireField(o, 'fieldName')
 *  - if (!o.fieldName) throw
 *  - if (!input.fieldName) throw
 *  - if (!body.fieldName) throw
 */
function isFieldRequiredInValidator(fieldName: string, validatorBody: string): boolean {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\brequire\\w*\\s*\\([^)]*['"]${escaped}['"]`),
    new RegExp(`if\\s*\\(!\\w+\\.${escaped}\\b`),
    new RegExp(`if\\s*\\(\\w+\\.${escaped}\\s*===\\s*(?:undefined|null|''|"")`),
    new RegExp(`if\\s*\\(!\\w+\\.${escaped}\\s*\\|\\|`),
    new RegExp(`\\.${escaped}\\s+is required`),
    new RegExp(`['"]${escaped}['"]\\.\\s*required`),
    new RegExp(`assert\\w*\\s*\\([^)]*\\.${escaped}\\b`),
    new RegExp(`\\.${escaped}\\b[^.]*?throw`),
  ];
  return patterns.some(p => p.test(validatorBody));
}

/**
 * Extract the body of a function given its name in the content.
 */
function extractFunctionBody(fnName: string, content: string): string | null {
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const FN_RE = new RegExp(`\\b${escaped}\\b[^{]*\\{`);
  const idx = content.search(FN_RE);
  if (idx < 0) return null;

  const startIdx = content.indexOf('{', idx);
  if (startIdx < 0) return null;

  let depth = 0;
  let started = false;
  let end = startIdx;

  for (let i = startIdx; i < content.length && (i - startIdx) < 5000; i++) {
    if (content[i] === '{') { depth++; started = true; }
    if (content[i] === '}') depth--;
    if (started && depth === 0) { end = i; break; }
  }

  return content.slice(startIdx, end + 1);
}

export function detectTsContractMismatches(files: CodeFile[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];

  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file.path)) continue;

    const interfaces = extractInputInterfaces(file.content);

    for (const iface of interfaces) {
      // Find the corresponding validator in this file or nearby
      const validatorName = findValidatorForInterface(iface.name, file.content);
      if (!validatorName) continue;

      const validatorBody = extractFunctionBody(validatorName, file.content);
      if (!validatorBody) continue;

      for (const field of iface.optionalFields) {
        if (isFieldRequiredInValidator(field, validatorBody)) {
          issues.push({
            id: 'ts-contract-mismatch',
            severity: 'HIGH',
            file: file.path,
            line: iface.startLine,
            message: `TypeScript contract mismatch: '${field}' is optional in ${iface.name} but required at runtime`,
            detail:
              `In ${file.path}, the interface '${iface.name}' declares field '${field}' as optional (\`${field}?: ...\`), ` +
              `but the validator '${validatorName}' treats it as required (throws or errors if absent). ` +
              `Callers that omit '${field}' will pass TypeScript checks but fail at runtime.`,
            fixHint:
              `Either make the field required in the interface (\`${field}: type\`), ` +
              `or remove the required check from '${validatorName}' and handle the absent case gracefully.`,
          });
        }
      }
    }
  }

  return issues;
}
