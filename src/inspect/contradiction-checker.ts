/**
 * Detects logical contradictions between rules in a compiled manifest.
 *
 * Runs two passes:
 *   1. Deterministic — catches field-value conflicts and unreachable-state guards
 *      with no LLM call; zero latency.
 *   2. Semantic (LLM) — catches implicit contradictions a pattern-matcher cannot
 *      see, e.g. "anonymous users can book" vs "users must verify email before
 *      booking". Uses claude-haiku for speed.
 *
 * Called by compile-spec before manifest.json is written. CRITICAL contradictions
 * block the write so Claude never spends time building contradictory code.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Manifest, Rule } from '../types';

// ── Public types ──────────────────────────────────────────────────────────────

export interface Contradiction {
  ruleA: string;
  ruleB: string;
  titleA: string;
  titleB: string;
  type: 'field_conflict' | 'state_unreachable' | 'semantic';
  field?: string;
  description: string;
  severity: 'CRITICAL' | 'WARNING';
  resolution: string;
}

export interface ContradictionReport {
  contradictions: Contradiction[];
  hasBlockers: boolean;   // true if any CRITICAL severity
  summary: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface FieldConstraint {
  field: string;
  operator: '==' | '!=';
  value: string;
  ruleId: string;
  ruleTitle: string;
}

// ── Condition parser ──────────────────────────────────────────────────────────

/**
 * Extract simple equality/inequality constraints from a rule condition.
 * Handles:  entity.field == 'value'   entity.field == true   entity.field != ''
 */
function extractFieldConstraints(ruleId: string, ruleTitle: string, condition: string): FieldConstraint[] {
  const constraints: FieldConstraint[] = [];
  const pattern = /entity\.(\w+)\s*(==|!=)\s*(?:'([^']*)'|"([^"]*)"|(\w+))/g;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(condition)) !== null) {
    constraints.push({
      field:    m[1],
      operator: m[2] as '==' | '!=',
      value:    m[3] ?? m[4] ?? m[5],  // single-quoted | double-quoted | bare word
      ruleId,
      ruleTitle,
    });
  }

  return constraints;
}

// ── Deterministic checks ──────────────────────────────────────────────────────

/**
 * Returns a conflict description if two constraints on the same field are
 * mutually exclusive, or null if they can coexist.
 */
function conflictBetween(
  a: FieldConstraint,
  b: FieldConstraint,
): { description: string; resolution: string } | null {
  // == true vs == false  (boolean flip)
  const booleans = new Set(['true', 'false']);
  if (a.operator === '==' && b.operator === '==' && booleans.has(a.value) && booleans.has(b.value) && a.value !== b.value) {
    return {
      description: `${a.ruleId} ("${a.ruleTitle}") requires ${a.field} == ${a.value}, but ${b.ruleId} ("${b.ruleTitle}") requires ${a.field} == ${b.value}. Both cannot be true at the same time.`,
      resolution:  `Decide which rule should apply. If both are valid in different contexts, add an explicit state or actor guard so they don't overlap.`,
    };
  }

  // != '' vs == ''  (required vs must-be-empty on the same field)
  const aRequiresNonEmpty = a.operator === '!=' && a.value === '';
  const bRequiresEmpty    = b.operator === '==' && b.value === '';
  if (aRequiresNonEmpty && bRequiresEmpty) {
    return {
      description: `${a.ruleId} ("${a.ruleTitle}") requires ${a.field} to be non-empty, but ${b.ruleId} ("${b.ruleTitle}") requires it to be empty.`,
      resolution:  `Add a lifecycle or state guard so each rule only applies when it makes sense (e.g. before vs. after a certain step).`,
    };
  }
  const bRequiresNonEmpty = b.operator === '!=' && b.value === '';
  const aRequiresEmpty    = a.operator === '==' && a.value === '';
  if (bRequiresNonEmpty && aRequiresEmpty) {
    return {
      description: `${b.ruleId} ("${b.ruleTitle}") requires ${b.field} to be non-empty, but ${a.ruleId} ("${a.ruleTitle}") requires it to be empty.`,
      resolution:  `Add a lifecycle or state guard so each rule only applies when it makes sense (e.g. before vs. after a certain step).`,
    };
  }

  return null;
}

function detectFieldConflicts(rules: Record<string, Rule>): Contradiction[] {
  // Group constraints by entity.field key
  const byField: Record<string, FieldConstraint[]> = {};

  for (const [id, rule] of Object.entries(rules)) {
    for (const c of extractFieldConstraints(id, rule.title, rule.condition)) {
      const key = `${rule.entity}.${c.field}`;
      (byField[key] ??= []).push(c);
    }
  }

  const contradictions: Contradiction[] = [];
  const seen = new Set<string>();

  for (const [field, constraints] of Object.entries(byField)) {
    for (let i = 0; i < constraints.length; i++) {
      for (let j = i + 1; j < constraints.length; j++) {
        const a = constraints[i];
        const b = constraints[j];
        if (a.ruleId === b.ruleId) continue;

        const pairKey = [a.ruleId, b.ruleId].sort().join(':');
        if (seen.has(pairKey)) continue;

        const conflict = conflictBetween(a, b);
        if (conflict) {
          seen.add(pairKey);
          contradictions.push({
            ruleA:       a.ruleId,
            ruleB:       b.ruleId,
            titleA:      a.ruleTitle,
            titleB:      b.ruleTitle,
            type:        'field_conflict',
            field,
            description: conflict.description,
            severity:    'CRITICAL',
            resolution:  conflict.resolution,
          });
        }
      }
    }
  }

  return contradictions;
}

/**
 * Flag rules that guard on a state that can never be entered according to the
 * state machine transitions (i.e. no transition leads to that state).
 */
function detectStateUnreachable(manifest: Manifest, rules: Record<string, Rule>): Contradiction[] {
  const sm = manifest.stateMachine;
  if (!sm?.transitions?.length) return [];

  // States that are reachable (appear as a `to` target in at least one transition)
  const reachable = new Set(sm.transitions.map(t => t.to));
  // States that are only ever a `from` source — they're initial states, always reachable
  const onlyFrom  = new Set(
    sm.transitions.map(t => t.from).filter(s => !reachable.has(s))
  );

  const contradictions: Contradiction[] = [];

  for (const [id, rule] of Object.entries(rules)) {
    const m = rule.condition.match(/entity\.status\s*==\s*['"]?(\w+)['"]?/);
    if (!m) continue;

    const requiredState = m[1];
    const knownState    = Object.keys(sm.states ?? {}).includes(requiredState);

    if (knownState && !reachable.has(requiredState) && !onlyFrom.has(requiredState)) {
      contradictions.push({
        ruleA:       id,
        ruleB:       id,
        titleA:      rule.title,
        titleB:      'State Machine',
        type:        'state_unreachable',
        description: `${id} ("${rule.title}") guards on entity.status == '${requiredState}', but no transition in the state machine ever leads to that state — the guard can never be satisfied.`,
        severity:    'WARNING',
        resolution:  `Either add a transition that arrives at '${requiredState}', or update the rule condition to use a state that is actually reachable.`,
      });
    }
  }

  return contradictions;
}

// ── Semantic (LLM) check ──────────────────────────────────────────────────────

async function detectSemanticContradictions(
  manifest: Manifest,
  apiKey: string,
  alreadyFound: Set<string>,
): Promise<Contradiction[]> {
  const rules = Object.values(manifest.rules ?? {});
  if (rules.length < 2) return [];

  const client = new Anthropic({ apiKey });

  const ruleList = rules
    .map(r => `${r.id} [${r.type}] "${r.title}": ${r.message}  (condition: ${r.condition})`)
    .join('\n');

  const prompt = `You are a spec reviewer checking for logical contradictions before any code is written.

Rules:
${ruleList}

Find only CLEAR logical contradictions — pairs of rules that cannot both be satisfied at the same time by the same system. Do NOT flag:
- Rules that apply to different actor types or roles
- Rules that apply to different lifecycle states
- Rules that are each individually optional or conditional on different inputs
- Differences in severity or scope that don't create an actual conflict

For each real contradiction, reply with JSON:
{
  "contradictions": [
    {
      "ruleA": "RULE_XX",
      "ruleB": "RULE_YY",
      "description": "one sentence explaining why these two rules cannot both be satisfied",
      "resolution": "one sentence telling the user what to change"
    }
  ]
}

If none found: { "contradictions": [] }
Output ONLY valid JSON — no markdown fences, no preamble.`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text   = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}';
    const parsed = JSON.parse(text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''));

    const contradictions: Contradiction[] = [];

    for (const c of parsed.contradictions ?? []) {
      const pairKey = [c.ruleA, c.ruleB].sort().join(':');
      if (alreadyFound.has(pairKey)) continue;

      const rA = manifest.rules[c.ruleA];
      const rB = manifest.rules[c.ruleB];
      if (!rA || !rB) continue;

      contradictions.push({
        ruleA:       c.ruleA,
        ruleB:       c.ruleB,
        titleA:      rA.title,
        titleB:      rB.title,
        type:        'semantic',
        description: c.description,
        severity:    'CRITICAL',
        resolution:  c.resolution,
      });
    }

    return contradictions;
  } catch {
    // LLM check failed — degrade gracefully, return nothing
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function buildReport(contradictions: Contradiction[]): ContradictionReport {
  const hasBlockers    = contradictions.some(c => c.severity === 'CRITICAL');
  const criticalCount  = contradictions.filter(c => c.severity === 'CRITICAL').length;
  const warningCount   = contradictions.filter(c => c.severity === 'WARNING').length;

  if (contradictions.length === 0) {
    return { contradictions: [], hasBlockers: false, summary: '✓ No contradictions detected.' };
  }

  const parts: string[] = [];
  if (criticalCount > 0) parts.push(`${criticalCount} critical conflict${criticalCount !== 1 ? 's' : ''}`);
  if (warningCount  > 0) parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`);

  return { contradictions, hasBlockers, summary: parts.join(', ') + ' found in spec.' };
}

/** Fast, synchronous check — no LLM call. */
export function checkContradictions(manifest: Manifest): ContradictionReport {
  const rules = manifest.rules ?? {};
  return buildReport([
    ...detectFieldConflicts(rules),
    ...detectStateUnreachable(manifest, rules),
  ]);
}

/** Full check: deterministic pass first, then LLM semantic pass. */
export async function checkContradictionsWithLLM(
  manifest: Manifest,
  apiKey: string,
): Promise<ContradictionReport> {
  const rules = manifest.rules ?? {};

  const deterministic = [
    ...detectFieldConflicts(rules),
    ...detectStateUnreachable(manifest, rules),
  ];

  const alreadyFound = new Set(deterministic.map(c => [c.ruleA, c.ruleB].sort().join(':')));

  const semantic = await detectSemanticContradictions(manifest, apiKey, alreadyFound);

  return buildReport([...deterministic, ...semantic]);
}

/** Format a ContradictionReport as human-readable text for MCP output. */
export function renderContradictionReport(report: ContradictionReport): string {
  if (report.contradictions.length === 0) return report.summary;

  const lines: string[] = ['## Spec contradictions found', '', report.summary, ''];

  for (const c of report.contradictions) {
    const icon = c.severity === 'CRITICAL' ? '❌' : '⚠️';
    const pair = c.type === 'state_unreachable'
      ? `${c.ruleA} ↔ state machine`
      : `${c.ruleA} ↔ ${c.ruleB}`;
    lines.push(`${icon} **${pair}** [${c.severity}]`);
    lines.push(`   ${c.description}`);
    lines.push(`   → ${c.resolution}`);
    lines.push('');
  }

  if (report.hasBlockers) {
    lines.push('**manifest.json was not written.** Fix the conflicts above, then run compile-spec again.');
  }

  return lines.join('\n');
}
