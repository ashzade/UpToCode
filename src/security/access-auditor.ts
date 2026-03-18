/**
 * Pillar 3 — Security Audit: Access Control Verification
 *
 * For each entity in the manifest that has restricted write access
 * (not every actor can write it), scan HTTP route handlers for
 * write operations without auth/role guards.
 *
 * Focuses on the HTTP layer (Flask routes, Express routes) — the real
 * actor boundary in web apps. DB-layer functions are intentionally
 * excluded from write detection since they're called by actors, not by
 * external parties directly.
 */

import { Manifest } from '../types';
import { CodeFile } from '../diff-engine/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SecurityFinding {
  id: string;
  entity: string;
  field?: string;
  writeActors: string[];
  blockedActors: string[];
  location: { file: string; line: number };
  snippet: string;
  hasAuthGuard: boolean;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  fixHint: string;
}

export interface SecurityAuditResult {
  check: 'security_audit';
  manifestVersion: string;
  findings: SecurityFinding[];
  coveredEntities: string[];
  routeFilesScanned: string[];
  summary: string;
}

// ── Route file detection ─────────────────────────────────────────────────────

/** Returns true if the file contains HTTP route definitions. */
function isRouteFile(content: string): boolean {
  return (
    // Flask
    /@\w+\.route\s*\(/.test(content) ||
    // Express
    /(?:router|app)\.(get|post|put|patch|delete)\s*\(/.test(content) ||
    // FastAPI
    /@\w+\.(get|post|put|patch|delete)\s*\(/.test(content)
  );
}

// ── Auth guard patterns ──────────────────────────────────────────────────────

const AUTH_GUARD_PATTERNS: RegExp[] = [
  /\babort\s*\(\s*40[13]/,
  /raise\s+\w*(Permission|Unauthorized|Forbidden|Auth)\w*/i,
  /@login_required/,
  /@requires?\w*auth/i,
  /\brequire_permission\b/i,
  /\bif\s+not\s+\w*(user|auth|token|current)/i,
  /\bcurrent_user\b/,
  /\bg\.user\b/,
  /\bis_admin\b/i,
  /\bcheck_permission\b/i,
  /\bhas_role\b/i,
  /\breq\.(user|auth)\b/,
  /\bres\.status\(\s*40[13]\)/,
  /\brequireAuth\b/i,
  /\brequireRole\b/i,
  /\bcheckPermission\b/i,
  /\bisAuthenticated\b/i,
  /\bisAdmin\b/i,
  /\bpassport\.authenticate\b/i,
  /\bnew\s+\w*(Unauthorized|Forbidden|Auth)\w*Error\b/i,
  /throw\s+\w*(Unauthorized|Forbidden|Auth)\w*/i,
];

// ── Write pattern detection ──────────────────────────────────────────────────

/**
 * Precise write patterns for an entity. Avoids matching entity names that
 * appear in JSON templates, comments, or third-party library calls.
 */
function buildWritePatterns(entityName: string): RegExp[] {
  const snake = toSnakeCase(entityName);
  const lower = snake.toLowerCase();
  // Match both singular and common plurals (entity→entities, analysis→analyses, etc.)
  const pluralSuffix = lower.endsWith('y') ? `(?:y|ies)` :
                       lower.endsWith('s') ? `(?:s|es)?` :
                       `s?`;
  const tablePattern = lower.endsWith('y')
    ? lower.slice(0, -1) + pluralSuffix
    : lower + pluralSuffix;

  return [
    // SQL: INSERT [OR ...] INTO entity_name[s]
    new RegExp(`\\bINSERT\\b[^\\n]*\\bINTO\\b[^\\n]*\\b${tablePattern}\\b`, 'i'),
    // SQL: UPDATE entity_name[s] SET
    new RegExp(`\\bUPDATE\\b[^\\n]*\\b${tablePattern}\\b[^\\n]*\\bSET\\b`, 'i'),
    // SQL: DELETE FROM entity_name[s]
    new RegExp(`\\bDELETE\\b[^\\n]*\\bFROM\\b[^\\n]*\\b${tablePattern}\\b`, 'i'),
    // Python/JS ORM class method: Entity.create(, Entity.update(, Entity.insert(
    new RegExp(`\\b${entityName}\\.(create|update|insert|upsert|save|delete|destroy)\\s*\\(`),
    // SQLAlchemy: db.session.add(Entity(
    new RegExp(`db\\.session\\.(add|merge)\\s*\\(\\s*${entityName}\\b`),
    // Raw db call with entity name inside SQL string
    new RegExp(`(?:conn|db|cursor|session)\\s*\\.\\s*(?:execute|run|query)\\s*\\([^)]*(?:INSERT|UPDATE|DELETE)[^)]*\\b${tablePattern}\\b`, 'i'),
  ];
}

/** Field-level write patterns — more conservative to avoid false positives. */
function buildFieldWritePatterns(fieldName: string): RegExp[] {
  return [
    // obj.field = value (assignment, not comparison)
    new RegExp(`\\.${fieldName}\\s*=[^=]`),
    // SQL SET field = value
    new RegExp(`\\bSET\\b[^;\\n]*\\b${fieldName}\\s*=`, 'i'),
    // dict key assignment: {'field': ..., 'field': } in an execute() call
    new RegExp(`(?:execute|run|query)[\\s\\S]*?['"]${fieldName}['"]\\s*=`, 'i'),
  ];
}

// ── Comment/string line filtering ────────────────────────────────────────────

/** Skip lines that are comments or appear to be inside docstrings. */
function isCommentOrDocstring(line: string, inDocstring: boolean): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) return true;
  if (inDocstring) return true;
  return false;
}

function trackDocstring(line: string, inDocstring: boolean): boolean {
  const trimmed = line.trim();
  const tripleDouble = (trimmed.match(/"""/g) || []).length;
  const tripleSingle = (trimmed.match(/'''/g) || []).length;
  if (tripleDouble % 2 !== 0 || tripleSingle % 2 !== 0) return !inDocstring;
  return inDocstring;
}

// ── Route handler extraction ─────────────────────────────────────────────────

interface RouteHandler {
  startLine: number;  // 1-based, line of @route decorator or route definition
  bodyLines: string[];
  bodyStartLine: number;
}

/**
 * Extract all route handler bodies from a file.
 * For Flask: starts at @app.route / @blueprint.route decorator.
 * For Express: starts at router.METHOD( / app.METHOD( call.
 */
function extractRouteHandlers(lines: string[], language: 'python' | 'ts-js'): RouteHandler[] {
  const handlers: RouteHandler[] = [];

  if (language === 'python') {
    for (let i = 0; i < lines.length; i++) {
      if (!/@\w+\.(route|get|post|put|patch|delete)\s*\(/.test(lines[i])) continue;

      const startLine = i + 1;
      // Find the def line
      let defLine = i + 1;
      while (defLine < lines.length && !/^\s*(?:async\s+)?def\s+/.test(lines[defLine])) defLine++;
      if (defLine >= lines.length) continue;

      // Extract function body
      const baseIndent = (lines[defLine].match(/^(\s*)/) ?? ['', ''])[1].length;
      const body: string[] = [lines[defLine]];
      for (let j = defLine + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') { body.push(line); continue; }
        const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
        if (indent <= baseIndent) break;
        body.push(line);
      }
      handlers.push({ startLine, bodyLines: body, bodyStartLine: defLine + 1 });
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (!/(?:router|app)\.(get|post|put|patch|delete|use)\s*\(/.test(lines[i])) continue;

      const startLine = i + 1;
      // Collect the route handler body by balancing braces from this line
      let depth = 0;
      const body: string[] = [];
      for (let j = i; j < lines.length; j++) {
        body.push(lines[j]);
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        if (depth <= 0 && j > i) break;
      }
      handlers.push({ startLine, bodyLines: body, bodyStartLine: startLine });
    }
  }

  return handlers;
}

// ── Actor permission parsing ─────────────────────────────────────────────────

interface EntityAccess {
  entityName: string;
  field?: string;
  writeActors: string[];
  blockedActors: string[];
}

/**
 * Normalize an entity name from the write list to match manifest entity keys.
 * Handles: "entities" → "Entity", "documents" → "Document", "analyses" → "Analysis"
 */
function normalizeEntityRef(ref: string, entityNames: string[]): string | null {
  // Try exact match first
  if (entityNames.includes(ref)) return ref;
  // Try PascalCase conversion of the raw ref
  const pascal = toPascalCase(ref);
  if (entityNames.includes(pascal)) return pascal;
  // Try stripping plural: "entities" → "entity" → "Entity"
  const singular = ref.endsWith('ies') ? ref.slice(0, -3) + 'y' :
                   ref.endsWith('es')  ? ref.slice(0, -2) :
                   ref.endsWith('s')   ? ref.slice(0, -1) : ref;
  const singularPascal = toPascalCase(singular);
  if (entityNames.includes(singularPascal)) return singularPascal;
  return null;
}

function buildRestrictedEntities(manifest: Manifest): EntityAccess[] {
  const allActors = Object.keys(manifest.actors);
  const entityNames = Object.keys(manifest.dataModel);
  const results: EntityAccess[] = [];
  const seen = new Set<string>();

  const wildcardActors = allActors.filter(a => manifest.actors[a].write === '*');

  // Map: normalized entity name → actors who can write it
  const entityWriteActors = new Map<string, string[]>();
  // Map: "Entity.field" → actors who can write that field
  const fieldWriteActors = new Map<string, string[]>();

  for (const [actorName, actor] of Object.entries(manifest.actors)) {
    if (actor.write === '*' || actor.write === 'none') continue;
    for (const target of actor.write) {
      if (target.includes('.')) {
        // Field-level: "tasks.done" — normalize the entity part
        const [entityPart, field] = target.split('.', 2);
        const resolved = normalizeEntityRef(entityPart, entityNames);
        const key = resolved ? `${resolved}.${field}` : target;
        if (!fieldWriteActors.has(key)) fieldWriteActors.set(key, []);
        fieldWriteActors.get(key)!.push(actorName);
      } else {
        const resolved = normalizeEntityRef(target, entityNames);
        if (!resolved) continue;
        if (!entityWriteActors.has(resolved)) entityWriteActors.set(resolved, []);
        entityWriteActors.get(resolved)!.push(actorName);
      }
    }
  }

  // Entity-level restrictions
  for (const entityName of entityNames) {
    const direct = entityWriteActors.get(entityName) ?? [];
    const writers = [...new Set([...direct, ...wildcardActors])];
    const blocked = allActors.filter(a => !writers.includes(a));
    if (blocked.length > 0 && !seen.has(entityName)) {
      seen.add(entityName);
      results.push({ entityName, writeActors: writers, blockedActors: blocked });
    }
  }

  // Field-level restrictions
  for (const [key, writers] of fieldWriteActors.entries()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const [entityName, field] = key.split('.', 2);
    const allWriters = [...new Set([...writers, ...wildcardActors])];
    const blocked = allActors.filter(a => !allWriters.includes(a));
    if (blocked.length > 0) {
      results.push({ entityName, field, writeActors: allWriters, blockedActors: blocked });
    }
  }

  return results;
}

// ── Core audit ───────────────────────────────────────────────────────────────

export function securityAudit(manifest: Manifest, files: CodeFile[]): SecurityAuditResult {
  const restricted = buildRestrictedEntities(manifest);
  const findings: SecurityFinding[] = [];
  const coveredEntities = new Set<string>();
  const routeFilesScanned: string[] = [];
  let findingId = 1;

  // Only scan files that contain HTTP route definitions
  const routeFiles = files.filter(f => isRouteFile(f.content));
  for (const f of routeFiles) routeFilesScanned.push(f.path);

  for (const file of routeFiles) {
    const lang: 'python' | 'ts-js' = file.path.endsWith('.py') ? 'python' : 'ts-js';
    const lines = file.content.split('\n');
    const handlers = extractRouteHandlers(lines, lang);

    for (const access of restricted) {
      const { entityName, field, writeActors, blockedActors } = access;
      const patterns = field
        ? buildFieldWritePatterns(field)
        : buildWritePatterns(entityName);

      const severity: SecurityFinding['severity'] =
        blockedActors.length >= 2 ? 'HIGH' :
        blockedActors.length === 1 ? 'MEDIUM' : 'LOW';

      for (const handler of handlers) {
        let inDocstring = false;
        for (let li = 0; li < handler.bodyLines.length; li++) {
          const line = handler.bodyLines[li];
          inDocstring = trackDocstring(line, inDocstring);
          if (isCommentOrDocstring(line, inDocstring)) continue;

          if (!patterns.some(p => p.test(line))) continue;

          const target = field ? `${entityName}.${field}` : entityName;
          const guarded = hasAuthGuard(handler.bodyLines);
          const absoluteLine = handler.bodyStartLine + li;

          if (guarded) {
            coveredEntities.add(target);
          } else {
            findings.push({
              id: `S${String(findingId++).padStart(2, '0')}`,
              entity: entityName,
              field,
              writeActors,
              blockedActors,
              location: { file: file.path, line: absoluteLine },
              snippet: line.trim().slice(0, 120),
              hasAuthGuard: false,
              severity: field ? 'LOW' : severity,
              description: field
                ? `Route writes restricted field '${target}' without actor check. Only ${writeActors.join(', ')} may write this field.`
                : `Route writes '${entityName}' without actor check. Actors ${blockedActors.join(', ')} are not permitted to write this entity.`,
              fixHint: field
                ? `Verify the caller is ${writeActors.join(' or ')} before writing '${field}'.`
                : `Add an actor/role check before writing '${entityName}'. Only ${writeActors.join(', ')} should reach this code path.`,
            });
          }
        }
      }
    }
  }

  // Deduplicate: one finding per (entity, file, handler)
  const deduped = deduplicateFindings(findings);

  const total = deduped.length;
  const summary = total === 0
    ? `✓ No unguarded writes to restricted entities in ${routeFilesScanned.length} route file(s).`
    : `${total} unguarded write${total !== 1 ? 's' : ''} to restricted entities across ${routeFilesScanned.length} route file(s). ${coveredEntities.size} write path${coveredEntities.size !== 1 ? 's' : ''} correctly guarded.`;

  return {
    check: 'security_audit',
    manifestVersion: manifest.meta.version,
    findings: deduped,
    coveredEntities: [...coveredEntities],
    routeFilesScanned,
    summary,
  };
}

function hasAuthGuard(bodyLines: string[]): boolean {
  const body = bodyLines.join('\n');
  return AUTH_GUARD_PATTERNS.some(p => p.test(body));
}

/** Remove duplicate findings for the same entity written in the same handler. */
function deduplicateFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  const result: SecurityFinding[] = [];
  let id = 1;
  for (const f of findings) {
    const key = `${f.entity}:${f.field ?? ''}:${f.location.file}:${Math.floor(f.location.line / 10)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...f, id: `S${String(id++).padStart(2, '0')}` });
    }
  }
  return result;
}

// ── Markdown renderer ────────────────────────────────────────────────────────

export function renderSecurityReport(result: SecurityAuditResult): string {
  const lines: string[] = [];
  lines.push(`# Security Audit — v${result.manifestVersion}`);
  lines.push('');
  lines.push(`**${result.summary}**`);
  lines.push('');
  lines.push(`Route files scanned: ${result.routeFilesScanned.map(p => p.split('/').pop()).join(', ') || '(none)'}`);
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n');
  }

  const bySev = result.findings.reduce<Record<string, number>>((a, f) => {
    a[f.severity] = (a[f.severity] ?? 0) + 1; return a;
  }, {});

  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const sev of ['HIGH', 'MEDIUM', 'LOW']) {
    if (bySev[sev]) lines.push(`| ${sev} | ${bySev[sev]} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    const group = result.findings.filter(f => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${sev} Severity`);
    lines.push('');
    for (const f of group) {
      const target = f.field ? `${f.entity}.${f.field}` : f.entity;
      lines.push(`### ${f.id}: Unguarded write to \`${target}\``);
      lines.push('');
      lines.push(`**File:** \`${f.location.file}:${f.location.line}\``);
      lines.push(`**Write actors:** ${f.writeActors.join(', ') || '(none)'}`);
      lines.push(`**Blocked actors:** ${f.blockedActors.join(', ')}`);
      lines.push('');
      lines.push('```');
      lines.push(f.snippet);
      lines.push('```');
      lines.push('');
      lines.push(`**Description:** ${f.description}`);
      lines.push(`**Fix:** ${f.fixHint}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  if (result.coveredEntities.length > 0) {
    lines.push('## Correctly Guarded Writes');
    lines.push('');
    for (const e of result.coveredEntities) lines.push(`- \`${e}\``);
  }

  return lines.join('\n');
}

// ── Utilities ────────────────────────────────────────────────────────────────

function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function toPascalCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
          .replace(/^[a-z]/, c => c.toUpperCase());
}
