import { CodeFile } from '../diff-engine/types';
import { CoherenceIssue } from './types';

/**
 * Determine if a file is an API route handler.
 * Matches Next.js app-router routes, Express routes, and pages-api routes.
 */
function isApiRouteFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    /\/app\/api\/[^/]+\/route\.(ts|js)$/.test(normalized) ||
    /\/routes\/[^/]+\.(ts|js)$/.test(normalized) ||
    /\/pages\/api\/.*\.(ts|js)$/.test(normalized)
  );
}

/**
 * Extract the "resource group" from a file path.
 * e.g. /app/api/search/route.ts → 'search'
 *      /app/api/search-more/route.ts → 'search'  (strip suffix after -)
 *      /routes/users.ts → 'users'
 */
function extractResourceGroup(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');

  // Next.js App Router: /app/api/<resource>/route.ts
  let m = normalized.match(/\/app\/api\/([^/]+)\/route\.(ts|js)$/);
  if (m) {
    // Group 'search-more' with 'search' by taking the stem before the first '-'
    return m[1].split('-')[0];
  }

  // Pages API: /pages/api/<resource>.ts
  m = normalized.match(/\/pages\/api\/([^/]+)\.(ts|js)$/);
  if (m) return m[1].split('-')[0];

  // Express routes: /routes/<resource>.ts
  m = normalized.match(/\/routes\/([^/]+)\.(ts|js)$/);
  if (m) return m[1].split('-')[0];

  return normalized.split('/').pop()?.replace(/\.(ts|js)$/, '').split('-')[0] ?? 'unknown';
}

/**
 * Extract top-level keys from a NextResponse.json({...}) or res.json({...}) call.
 * Returns null if the shape can't be determined (dynamic key, variable, etc.).
 */
function extractJsonResponseKeys(content: string): Set<string> | null {
  const keys = new Set<string>();

  // Match NextResponse.json({ key1: ..., key2: ... }) or res.json({ ... })
  const JSON_CALL_RE = /(?:NextResponse\.json|res\.json)\s*\(\s*\{([^}]{0,500})\}/g;
  let m: RegExpExecArray | null;
  let found = false;

  while ((m = JSON_CALL_RE.exec(content)) !== null) {
    found = true;
    const inner = m[1];

    // Extract top-level keys: must be simple identifier: or "string":
    const KEY_RE = /^\s*(?:'(\w+)'|"(\w+)"|(\w+))\s*:/gm;
    let km: RegExpExecArray | null;
    while ((km = KEY_RE.exec(inner)) !== null) {
      const key = km[1] ?? km[2] ?? km[3];
      if (key) keys.add(key);
    }
  }

  if (!found) return null;
  if (keys.size === 0) return null;
  return keys;
}

/**
 * Summarise a key set as a canonical sorted string for comparison.
 */
function keySetSignature(keys: Set<string>): string {
  return [...keys].sort().join(',');
}

export function detectApiCoherence(files: CodeFile[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];

  const apiFiles = files.filter(f => isApiRouteFile(f.path));

  // Group by resource
  const byResource = new Map<string, Array<{ file: string; keys: Set<string> }>>();

  for (const file of apiFiles) {
    const keys = extractJsonResponseKeys(file.content);
    if (!keys) continue;

    const resource = extractResourceGroup(file.path);
    const existing = byResource.get(resource) ?? [];
    existing.push({ file: file.path, keys });
    byResource.set(resource, existing);
  }

  // Flag resource groups where routes return different envelope shapes
  for (const [resource, routes] of byResource) {
    if (routes.length < 2) continue;

    const signatures = routes.map(r => ({ sig: keySetSignature(r.keys), file: r.file, keys: r.keys }));
    const uniqueSigs = new Set(signatures.map(s => s.sig));

    if (uniqueSigs.size <= 1) continue;

    // There are different envelope shapes — flag each route that differs from the majority
    const sigCounts = new Map<string, number>();
    for (const { sig } of signatures) sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);

    // The most common shape is the "canonical" one
    let canonicalSig = '';
    let maxCount = 0;
    for (const [sig, count] of sigCounts) {
      if (count > maxCount) { maxCount = count; canonicalSig = sig; }
    }

    for (const { sig, file, keys } of signatures) {
      if (sig === canonicalSig) continue;

      const canonicalKeys = canonicalSig.split(',');
      const actualKeys = [...keys].sort();
      const missing = canonicalKeys.filter(k => !actualKeys.includes(k));
      const extra = actualKeys.filter(k => !canonicalKeys.includes(k));

      const detail: string[] = [];
      if (missing.length > 0) detail.push(`missing: ${missing.join(', ')}`);
      if (extra.length > 0) detail.push(`extra: ${extra.join(', ')}`);

      issues.push({
        id: 'api-envelope-mismatch',
        severity: 'LOW',
        file,
        message: `API envelope inconsistency in '${resource}' resource group`,
        detail:
          `Route '${file}' returns JSON keys {${actualKeys.join(', ')}} but sibling routes for the ` +
          `'${resource}' resource use {${canonicalKeys.join(', ')}}. Difference: ${detail.join('; ')}.`,
        fixHint:
          `Standardise the JSON envelope for all '${resource}' routes. ` +
          `Either add the missing keys (${missing.join(', ')}) or align the shape with a shared response type.`,
      });
    }
  }

  return issues;
}
