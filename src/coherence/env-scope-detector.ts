import { Manifest } from '../types';
import { CodeFile } from '../diff-engine/types';
import { CoherenceIssue } from './types';

/**
 * Extract env var names referenced in rule conditions via env(VAR_NAME).
 */
function extractEnvVarsFromManifest(manifest: Manifest): Set<string> {
  const vars = new Set<string>();

  // From rule conditions
  for (const rule of Object.values(manifest.rules)) {
    const matches = [...rule.condition.matchAll(/\benv\(([^)]+)\)/gi)];
    for (const m of matches) vars.add(m[1].trim());
  }

  // From externalProviders — look for env[] arrays if present at runtime
  for (const provider of Object.values(manifest.externalProviders ?? {})) {
    const p = provider as typeof provider & { env?: string[] };
    if (Array.isArray(p.env)) {
      for (const v of p.env) vars.add(v);
    }
  }

  return vars;
}

/**
 * Returns true if a line looks like a top-level (module-scope) assignment.
 * We heuristically determine "top-level" by checking that the line has zero
 * or very small leading indentation (≤2 spaces) and is a const/let/var declaration.
 */
function isTopLevelLine(line: string): boolean {
  const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
  return indent <= 2;
}

/**
 * Detects env vars that are read at module scope (top-level const/let/var)
 * rather than inside a function body.
 *
 * Flags: const X = process.env.X  or  const X = process.env['X']
 * at file top level (indentation ≤ 2 spaces, not inside a function).
 */
export function detectEnvScope(manifest: Manifest, files: CodeFile[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];
  const declaredEnvVars = extractEnvVarsFromManifest(manifest);

  // If manifest has no env vars declared, nothing to cross-reference
  if (declaredEnvVars.size === 0) return [];

  // Regex: const/let/var NAME = process.env.NAME  or  process.env['NAME']
  const TOP_LEVEL_ENV_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*process\.env(?:\.(\w+)|\[['"](\w+)['"]\])/;

  for (const file of files) {
    if (!/\.(ts|tsx|js)$/.test(file.path)) continue;

    const lines = file.content.split('\n');
    // Track brace depth to determine if we're inside a function body
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Update brace depth
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }

      // Only flag truly top-level lines (not inside any block)
      if (braceDepth !== 0) continue;
      if (!isTopLevelLine(line)) continue;

      const m = line.match(TOP_LEVEL_ENV_RE);
      if (!m) continue;

      // The env var name is either captured from .NAME or ['NAME']
      const envVarName = m[2] ?? m[3];
      if (!envVarName) continue;

      // Only flag if this env var is in the manifest
      if (!declaredEnvVars.has(envVarName)) continue;

      issues.push({
        id: 'env-scope',
        severity: 'MEDIUM',
        file: file.path,
        line: i + 1,
        message: `Env var '${envVarName}' read at module scope`,
        detail:
          `'process.env.${envVarName}' is read at module/top level in ${file.path} (line ${i + 1}). ` +
          `This means the value is captured once at startup. If the env var is not yet set when the ` +
          `module loads (e.g. in test environments or serverless cold starts), it will silently be undefined.`,
        fixHint:
          `Move the 'process.env.${envVarName}' read inside the function that uses it, ` +
          `or use a lazy getter: \`function getApiKey() { return process.env.${envVarName}; }\`.`,
      });
    }
  }

  return issues;
}
