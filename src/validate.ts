import { Manifest } from './types';
import { ParseError } from './errors';

/**
 * Extract rule ID tokens from a guard expression.
 * Tokenize by splitting on AND, OR, NOT, (, ), whitespace.
 */
function extractRuleIdsFromGuard(guard: string): string[] {
  const tokens = guard
    .replace(/\(/g, ' ')
    .replace(/\)/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && t !== 'AND' && t !== 'OR' && t !== 'NOT');

  return tokens.filter(t => /^RULE_/.test(t));
}

/**
 * Scan a condition/filter string for ProviderName.method( patterns.
 * Returns an array of { provider, method } pairs.
 */
function extractProviderCalls(text: string): Array<{ provider: string; method: string }> {
  const results: Array<{ provider: string; method: string }> = [];
  // Match PascalCase.methodName(
  const regex = /([A-Z][A-Za-z0-9]*)\.([a-z_][a-zA-Z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    results.push({ provider: match[1], method: match[2] });
  }
  return results;
}

/**
 * Extract computed property names referenced in a condition string.
 * Computed property names are bare identifiers (snake_case) not preceded by a dot.
 * We look for identifiers that are in the computedProperties map.
 */
function extractComputedRefs(condition: string, computedNames: Set<string>): string[] {
  // Match word boundaries for identifiers
  const refs: string[] = [];
  const regex = /(?<!\.)([a-z_][a-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(condition)) !== null) {
    const token = match[1];
    if (computedNames.has(token)) {
      refs.push(token);
    }
  }
  return refs;
}

function checkCircularInheritance(
  actorName: string,
  actors: Record<string, { inherits?: string }>,
  visited: Set<string> = new Set()
): void {
  if (visited.has(actorName)) {
    throw new ParseError(
      `Circular inheritance detected involving actor "${actorName}"`,
      undefined,
      'Actors & Access'
    );
  }
  const actor = actors[actorName];
  if (actor?.inherits) {
    visited.add(actorName);
    checkCircularInheritance(actor.inherits, actors, visited);
  }
}

export function validate(manifest: Manifest): void {
  const ruleIds = new Set(Object.keys(manifest.rules));
  const providerNames = new Set(Object.keys(manifest.externalProviders));
  const computedNames = new Set(Object.keys(manifest.computedProperties));
  const actorNames = new Set(Object.keys(manifest.actors));

  // 1. Validate actor inheritance: parent actors must exist, no circular chains
  for (const [name, actor] of Object.entries(manifest.actors)) {
    if (actor.inherits) {
      if (!actorNames.has(actor.inherits)) {
        throw new ParseError(
          `Actor "${name}" inherits from unknown actor "${actor.inherits}"`,
          undefined,
          'Actors & Access'
        );
      }
      checkCircularInheritance(name, manifest.actors);
    }
  }

  // 2. Validate enforcement rule IDs exist
  for (const directive of manifest.enforcement) {
    if (!ruleIds.has(directive.ruleId)) {
      throw new ParseError(
        `Enforcement references unknown rule ID "${directive.ruleId}"`,
        undefined,
        'Actors & Access'
      );
    }
  }

  // 3. Validate transition guard rule IDs
  for (const transition of manifest.stateMachine.transitions) {
    if (transition.guard) {
      const guardRuleIds = extractRuleIdsFromGuard(transition.guard);
      for (const ruleId of guardRuleIds) {
        if (!ruleIds.has(ruleId)) {
          throw new ParseError(
            `Transition ${transition.from} → ${transition.to} guard references unknown rule ID "${ruleId}"`,
            undefined,
            'State Machine'
          );
        }
      }
    }
  }

  // 4. Validate external(ProviderName) modifiers in data model
  for (const [entityName, entity] of Object.entries(manifest.dataModel)) {
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      for (const mod of field.modifiers) {
        if (mod.name === 'external') {
          const providerName = mod.args[0];
          if (providerName && !providerNames.has(providerName)) {
            throw new ParseError(
              `Field "${entityName}.${fieldName}" references unknown provider "${providerName}"`,
              undefined,
              'Data Model'
            );
          }
        }
      }
    }
  }

  // 5. Validate provider method calls in rule conditions and computed filters
  const allPredicates: Array<{ text: string; context: string }> = [];

  for (const [name, rule] of Object.entries(manifest.rules)) {
    allPredicates.push({ text: rule.condition, context: `Rule "${name}"` });
  }

  for (const [name, cp] of Object.entries(manifest.computedProperties)) {
    allPredicates.push({ text: cp.filter, context: `Computed property "${name}" filter` });
  }

  for (const { text, context } of allPredicates) {
    const calls = extractProviderCalls(text);
    for (const { provider, method } of calls) {
      if (!providerNames.has(provider)) {
        // Could be a non-provider PascalCase reference (e.g. "Session.created_at")
        // Only validate if it looks like a provider
        continue;
      }
      const providerDef = manifest.externalProviders[provider];
      const methodExists = providerDef.methods.some(m => m.name === method);
      if (!methodExists) {
        throw new ParseError(
          `${context} calls undeclared method "${provider}.${method}()"`,
          undefined,
          'Logic Rules'
        );
      }
    }
  }

  // 6. Validate computed property references in rule conditions
  for (const [name, rule] of Object.entries(manifest.rules)) {
    const refs = extractComputedRefs(rule.condition, computedNames);
    for (const ref of refs) {
      if (!computedNames.has(ref)) {
        throw new ParseError(
          `Rule "${name}" condition references unknown computed property "${ref}"`,
          undefined,
          'Logic Rules'
        );
      }
    }
  }
}
