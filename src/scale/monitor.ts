/**
 * Pillar 4 — Scale Monitor
 *
 * Derives health checks from the manifest (entity states, computed properties,
 * FK integrity) and evaluates them against a live SQLite database.
 *
 * No thresholds are hard-coded in the manifest; this module applies
 * standard operating rules:
 *   - PENDING backlog > 0 → info; > 20 → warning
 *   - FAILED ratio > 10% → warning; > 25% → critical
 *   - Orphaned FK records > 0 → warning
 *   - Computed property value reported as-is (no threshold)
 */

import { Manifest, Field } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckStatus = 'ok' | 'info' | 'warning' | 'critical' | 'skip';

export interface HealthCheck {
  id: string;
  category: 'state' | 'computed' | 'integrity' | 'volume';
  name: string;
  description: string;
  sql: string;
  value: number | null;
  status: CheckStatus;
  detail: string;
}

export interface ScaleReport {
  check: 'scale_monitor';
  manifestVersion: string;
  dbPath: string;
  timestamp: string;
  checks: HealthCheck[];
  summary: string;
}

// ── SQLite query execution ───────────────────────────────────────────────────

function runQuery(dbPath: string, sql: string): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        prepare: (sql: string) => { get: () => Record<string, unknown> };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare(sql).get();
      if (!row) return 0;
      const val = Object.values(row)[0];
      return typeof val === 'number' ? val : Number(val) || 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ── Name normalization ───────────────────────────────────────────────────────

/** PascalCase entity name → probable SQL table name (plural snake_case). */
function entityToTable(entityName: string): string {
  const snake = entityName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  if (snake.endsWith('sis')) return snake.slice(0, -3) + 'ses'; // analysis → analyses
  if (snake.endsWith('y'))   return snake.slice(0, -1) + 'ies'; // entity → entities
  if (snake.endsWith('s'))   return snake;                       // already plural
  return snake + 's';
}

// ── Predicate → SQL translator ───────────────────────────────────────────────

/**
 * Translate a manifest predicate condition to a SQL WHERE clause.
 * Returns null if the condition contains unevaluable tokens
 * (env(), Provider calls, NOW(), INTERVAL(), computed property refs).
 */
function predicateToSQL(condition: string, computedNames: Set<string>): string | null {
  // Unevaluable tokens
  if (/\benv\s*\(|\bNOW\s*\(|\bINTERVAL\s*\(|[A-Z][a-zA-Z]+\.[a-z]/.test(condition)) return null;
  // Skip if it references a computed property by name (would require subquery)
  for (const name of computedNames) {
    if (new RegExp(`\\b${name}\\b`).test(condition)) return null;
  }

  let sql = condition;
  // entity.field → field
  sql = sql.replace(/\bentity\./g, '');
  // == → =
  sql = sql.replace(/==/g, '=');
  // boolean literals
  sql = sql.replace(/\btrue\b/gi, '1');
  sql = sql.replace(/\bfalse\b/gi, '0');
  // Strip outer quotes from empty string comparisons for clarity
  // 'value' stays 'value'
  return sql;
}

// ── Check generators ─────────────────────────────────────────────────────────

/**
 * Generate state distribution checks for each entity with a status enum field.
 * Produces one check per state value.
 */
/** Extract enum values from a field — checks both type string and modifiers. */
function getEnumValues(field: Field): string[] | null {
  // type = "enum('a', 'b', 'c')"
  const typeMatch = field.type.match(/^enum\((.+)\)$/i);
  if (typeMatch) {
    return typeMatch[1].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
  }
  // modifier: enum('a', 'b')
  const enumMod = field.modifiers.find(m => m.name === 'enum');
  if (enumMod) return enumMod.args.map(v => v.replace(/^['"]|['"]$/g, ''));
  return null;
}

function buildStateChecks(manifest: Manifest): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const states = Object.keys(manifest.stateMachine.states).map(s => s.toLowerCase());
  let id = 1;

  for (const [entityName, entity] of Object.entries(manifest.dataModel)) {
    // Find fields whose enum values overlap with state machine states
    const statusField = Object.values(entity.fields).find(f => {
      const vals = getEnumValues(f);
      return vals !== null && vals.some(v => states.includes(v.toLowerCase()));
    });
    if (!statusField) continue;

    const table = entityToTable(entityName);
    const stateValues = getEnumValues(statusField)!;
    const totalSQL = `SELECT COUNT(*) as n FROM ${table}`;

    for (const stateVal of stateValues) {
      const sql = `SELECT COUNT(*) as n FROM ${table} WHERE ${statusField.name} = '${stateVal}'`;
      checks.push({
        id: `SC${String(id++).padStart(2, '0')}`,
        category: 'state',
        name: `${entityName}.${statusField.name} = '${stateVal}'`,
        description: `Count of ${entityName} records in '${stateVal}' state`,
        sql,
        value: null,
        status: 'ok',
        detail: '',
        // Store totalSQL for ratio computation — resolved in evaluate()
        ...(stateVal === 'failed' ? { _totalSQL: totalSQL } : {}),
      } as HealthCheck & { _totalSQL?: string });
    }
  }
  return checks;
}

/**
 * Generate checks for each computed property that can be translated to SQL.
 */
function buildComputedChecks(manifest: Manifest): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const computedNames = new Set(Object.keys(manifest.computedProperties));
  let id = 1;

  for (const [propName, prop] of Object.entries(manifest.computedProperties)) {
    const table = entityToTable(prop.entity);
    const whereClause = predicateToSQL(prop.filter, computedNames);

    let sql: string;
    if (whereClause === null) {
      checks.push({
        id: `CP${String(id++).padStart(2, '0')}`,
        category: 'computed',
        name: propName,
        description: `${prop.aggregate}(${prop.entity}) — ${prop.filter}`,
        sql: '(unevaluable)',
        value: null,
        status: 'skip',
        detail: 'Condition references runtime values (env, provider, computed refs) — cannot evaluate statically.',
      });
      continue;
    }

    const aggFn = prop.aggregate === 'EXISTS' ? 'COUNT(*)' :
                  prop.aggregate === 'COUNT'  ? 'COUNT(*)' :
                  `${prop.aggregate}(*)`;

    sql = whereClause && whereClause.trim() && whereClause.trim() !== 'true'
      ? `SELECT ${aggFn} as n FROM ${table} WHERE ${whereClause}`
      : `SELECT ${aggFn} as n FROM ${table}`;

    checks.push({
      id: `CP${String(id++).padStart(2, '0')}`,
      category: 'computed',
      name: propName,
      description: `${prop.aggregate}(${prop.entity}) WHERE ${prop.filter}`,
      sql,
      value: null,
      status: 'ok',
      detail: '',
    });
  }
  return checks;
}

/**
 * Generate FK integrity checks for each FK field in the data model.
 */
function buildIntegrityChecks(manifest: Manifest): HealthCheck[] {
  const checks: HealthCheck[] = [];
  let id = 1;

  for (const [entityName, entity] of Object.entries(manifest.dataModel)) {
    const table = entityToTable(entityName);

    for (const field of Object.values(entity.fields)) {
      const fkMod = field.modifiers.find(m => m.name === 'fk');
      if (!fkMod || fkMod.args.length === 0) continue;

      // fk(ParentEntity.id, one-to-one) → fk(Document.id, ...)
      const [targetRef] = fkMod.args;
      const dotIdx = targetRef.indexOf('.');
      if (dotIdx === -1) continue;
      const parentEntity = targetRef.slice(0, dotIdx);
      const parentField = targetRef.slice(dotIdx + 1);
      const parentTable = entityToTable(parentEntity);

      const sql = `SELECT COUNT(*) as n FROM ${table} WHERE ${field.name} IS NOT NULL AND ${field.name} NOT IN (SELECT ${parentField} FROM ${parentTable})`;

      checks.push({
        id: `FK${String(id++).padStart(2, '0')}`,
        category: 'integrity',
        name: `${entityName}.${field.name} → ${parentEntity}.${parentField}`,
        description: `Orphaned ${entityName} records (${field.name} references non-existent ${parentEntity})`,
        sql,
        value: null,
        status: 'ok',
        detail: '',
      });
    }
  }
  return checks;
}

/**
 * Generate volume checks — total record count for each entity.
 */
function buildVolumeChecks(manifest: Manifest): HealthCheck[] {
  const checks: HealthCheck[] = [];
  let id = 1;

  for (const entityName of Object.keys(manifest.dataModel)) {
    const table = entityToTable(entityName);
    checks.push({
      id: `VL${String(id++).padStart(2, '0')}`,
      category: 'volume',
      name: `${entityName} total`,
      description: `Total record count for ${entityName}`,
      sql: `SELECT COUNT(*) as n FROM ${table}`,
      value: null,
      status: 'ok',
      detail: '',
    });
  }
  return checks;
}

// ── Threshold evaluation ─────────────────────────────────────────────────────

function evaluateStateCheck(check: HealthCheck, value: number, allChecks: HealthCheck[], dbPath: string): void {
  check.value = value;
  const nameLower = check.name.toLowerCase();

  if (nameLower.includes("'pending'")) {
    if (value === 0) {
      check.status = 'ok';
      check.detail = 'No pending records.';
    } else if (value <= 20) {
      check.status = 'info';
      check.detail = `${value} record(s) awaiting processing.`;
    } else {
      check.status = 'warning';
      check.detail = `${value} records in backlog — processing may be stalled.`;
    }
  } else if (nameLower.includes("'failed'")) {
    // Get total for ratio
    const entityMatch = check.name.match(/^(\w+)\./);
    if (entityMatch) {
      const table = entityToTable(entityMatch[1]);
      const total = runQuery(dbPath, `SELECT COUNT(*) as n FROM ${table}`) ?? 0;
      const ratio = total > 0 ? value / total : 0;
      if (ratio === 0) {
        check.status = 'ok';
        check.detail = 'No failures.';
      } else if (ratio < 0.1) {
        check.status = 'info';
        check.detail = `${value}/${total} (${(ratio * 100).toFixed(1)}%) failed.`;
      } else if (ratio < 0.25) {
        check.status = 'warning';
        check.detail = `${value}/${total} (${(ratio * 100).toFixed(1)}%) failed — elevated failure rate.`;
      } else {
        check.status = 'critical';
        check.detail = `${value}/${total} (${(ratio * 100).toFixed(1)}%) failed — critical failure rate.`;
      }
    } else {
      check.status = value > 0 ? 'warning' : 'ok';
      check.detail = value > 0 ? `${value} failed records.` : 'No failures.';
    }
  } else if (nameLower.includes("'processed'")) {
    check.status = 'ok';
    check.detail = value === 0 ? 'Nothing processed yet.' : `${value} records processed.`;
  } else {
    check.status = 'ok';
    check.detail = `${value} records.`;
  }
}

function evaluateComputedCheck(check: HealthCheck, value: number): void {
  check.value = value;
  check.status = 'ok';
  check.detail = `${value}`;
}

function evaluateIntegrityCheck(check: HealthCheck, value: number): void {
  check.value = value;
  if (value === 0) {
    check.status = 'ok';
    check.detail = 'No orphaned records.';
  } else {
    check.status = 'warning';
    check.detail = `${value} orphaned record(s) — referential integrity violation.`;
  }
}

function evaluateVolumeCheck(check: HealthCheck, value: number): void {
  check.value = value;
  check.status = 'ok';
  check.detail = `${value} total records.`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function runScaleMonitor(manifest: Manifest, dbPath: string): ScaleReport {
  const allChecks: HealthCheck[] = [
    ...buildStateChecks(manifest),
    ...buildComputedChecks(manifest),
    ...buildIntegrityChecks(manifest),
    ...buildVolumeChecks(manifest),
  ];

  // Execute each check
  for (const check of allChecks) {
    if (check.status === 'skip') continue;

    const value = runQuery(dbPath, check.sql);
    if (value === null) {
      check.status = 'skip';
      check.detail = 'Query failed — table may not exist or schema differs.';
      continue;
    }

    switch (check.category) {
      case 'state':     evaluateStateCheck(check, value, allChecks, dbPath); break;
      case 'computed':  evaluateComputedCheck(check, value); break;
      case 'integrity': evaluateIntegrityCheck(check, value); break;
      case 'volume':    evaluateVolumeCheck(check, value); break;
    }
  }

  // Summary
  const critical = allChecks.filter(c => c.status === 'critical').length;
  const warnings = allChecks.filter(c => c.status === 'warning').length;
  const skipped  = allChecks.filter(c => c.status === 'skip').length;
  const ran      = allChecks.length - skipped;

  const summary = critical > 0
    ? `${critical} critical, ${warnings} warning(s). ${ran} check(s) ran.`
    : warnings > 0
    ? `${warnings} warning(s). ${ran} check(s) ran, ${skipped} skipped.`
    : `All ${ran} check(s) passed.${skipped > 0 ? ` ${skipped} skipped.` : ''}`;

  return {
    check: 'scale_monitor',
    manifestVersion: manifest.meta.version,
    dbPath,
    timestamp: new Date().toISOString(),
    checks: allChecks,
    summary,
  };
}

// ── Markdown renderer ────────────────────────────────────────────────────────

const STATUS_ICON: Record<CheckStatus, string> = {
  ok:       '✓',
  info:     'ℹ',
  warning:  '⚠',
  critical: '✗',
  skip:     '—',
};

export function renderScaleReport(report: ScaleReport): string {
  const lines: string[] = [];
  lines.push(`# Scale Monitor — v${report.manifestVersion}`);
  lines.push(`_${report.timestamp}_`);
  lines.push('');
  lines.push(`**${report.summary}**`);
  lines.push('');

  const categories: Array<{ key: HealthCheck['category']; label: string }> = [
    { key: 'state',     label: 'State Distribution' },
    { key: 'computed',  label: 'Computed Properties' },
    { key: 'integrity', label: 'FK Integrity' },
    { key: 'volume',    label: 'Entity Volumes' },
  ];

  for (const { key, label } of categories) {
    const group = report.checks.filter(c => c.category === key);
    if (group.length === 0) continue;

    lines.push(`## ${label}`);
    lines.push('');
    lines.push('| Status | Check | Value | Detail |');
    lines.push('|---|---|---|---|');
    for (const c of group) {
      const icon = STATUS_ICON[c.status];
      const val = c.value !== null ? String(c.value) : '—';
      lines.push(`| ${icon} | ${c.name} | ${val} | ${c.detail} |`);
    }
    lines.push('');
  }

  // Show SQL for warnings/criticals so the user can investigate
  const actionable = report.checks.filter(c => c.status === 'warning' || c.status === 'critical');
  if (actionable.length > 0) {
    lines.push('## Actionable Queries');
    lines.push('');
    lines.push('Run these against your database to investigate:');
    lines.push('');
    for (const c of actionable) {
      lines.push(`**${c.id} — ${c.name}**`);
      lines.push('```sql');
      lines.push(c.sql);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}
