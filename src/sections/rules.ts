import { Rule } from '../types';
import { ParseError } from '../errors';

const VALID_TYPES = ['Validation', 'Business', 'Security'] as const;

// Tokens that are valid predicate operand prefixes or keywords
const VALID_OPERAND_PATTERNS = [
  /^entity\.[a-zA-Z_]/,          // entity.field
  /^actor\.(type|id)\b/,          // actor.type, actor.id
  /^env\([A-Z_][A-Z0-9_]*\)/,    // env(VAR_NAME)
  /^NOW\(\)/,                      // NOW()
  /^INTERVAL\(/,                   // INTERVAL(n, unit)
  /^'[^']*'/,                      // string literal
  /^[0-9]/,                        // numeric literal
  /^(true|false)\b/,               // boolean literal
  /^(AND|OR|NOT)\b/,               // logical operators
  /^\(/,                            // grouping
  /^\)/,
  /^(==|!=|>=|<=|>|<|-|\+|\*\/)/,  // comparators and arithmetic
  /^[A-Z][a-zA-Z]*\.[a-zA-Z]/,   // Provider.method(
  /^[a-z][a-z0-9_]*\.[a-zA-Z_]/, // input param reference (token.value, request.ip, etc.)
];

// Known computed-property references are bare snake_case names — we allow them
// but cannot validate against the manifest here (validate.ts handles that).
const COMPUTED_REF_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Validates that a condition string is composed only of recognised predicate
 * grammar tokens. Throws ParseError on the first unrecognised token.
 *
 * Bare UPPER_CASE identifiers (e.g. ANTHROPIC_API_KEY) are explicitly rejected
 * because they look like env vars but are missing the required env() wrapper.
 */
function validateCondition(condition: string, ruleId: string): void {
  // Tokenise by splitting on whitespace, then check each token
  const tokens = condition.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    // Test the original token first, then a version stripped of surrounding punctuation.
    // Stripping is needed when tokens like `(entity.status` appear adjacent to grouping chars.
    const stripped = token.replace(/^[(]+/, '').replace(/[(),]+$/, '');
    if (!stripped) continue;

    const isValid =
      VALID_OPERAND_PATTERNS.some(p => p.test(token)) ||
      VALID_OPERAND_PATTERNS.some(p => p.test(stripped)) ||
      COMPUTED_REF_PATTERN.test(stripped);

    if (!isValid) {
      // Provide a targeted hint for bare env-var style identifiers
      const bareEnvVarLike = /^[A-Z][A-Z0-9_]+$/.test(stripped);
      if (bareEnvVarLike) {
        throw new ParseError(
          `[${ruleId}] Condition contains unrecognised operand '${stripped}'. ` +
          `Environment variables must use env() syntax: env(${stripped}). ` +
          `Prose conditions are parse errors.`,
          undefined,
          'Logic Rules'
        );
      }
      throw new ParseError(
        `[${ruleId}] Condition contains unrecognised operand '${stripped}'. ` +
        `Use entity.field, actor.type, Provider.method(), env(VAR_NAME), NOW(), or a literal. ` +
        `Prose conditions are parse errors.`,
        undefined,
        'Logic Rules'
      );
    }
  }
}

export function parseRules(content: string): Record<string, Rule> {
  const rules: Record<string, Rule> = {};
  const lines = content.split('\n');

  let currentRule: Partial<Rule> | null = null;

  function saveRule() {
    if (currentRule && currentRule.id) {
      if (!currentRule.type) throw new ParseError(`Rule "${currentRule.id}" missing Type`, undefined, 'Logic Rules');
      if (!currentRule.entity) throw new ParseError(`Rule "${currentRule.id}" missing Entity`, undefined, 'Logic Rules');
      if (!currentRule.condition) throw new ParseError(`Rule "${currentRule.id}" missing Condition`, undefined, 'Logic Rules');
      if (!currentRule.message) throw new ParseError(`Rule "${currentRule.id}" missing Message`, undefined, 'Logic Rules');
      rules[currentRule.id] = currentRule as Rule;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip level-3 headings (### Validation Rules, ### Business Rules)
    if (trimmed.startsWith('### ')) continue;

    // Level-4 heading: #### RULE_ID: Title
    if (trimmed.startsWith('#### ')) {
      saveRule();
      const heading = trimmed.slice(5).trim();
      const colonIdx = heading.indexOf(':');
      if (colonIdx === -1) {
        throw new ParseError(`Rule heading missing colon: "${heading}"`, undefined, 'Logic Rules');
      }
      const id = heading.slice(0, colonIdx).trim();
      const title = heading.slice(colonIdx + 1).trim();
      currentRule = { id, title, references: [] };
      continue;
    }

    if (!currentRule) continue;

    if (trimmed.startsWith('Type:')) {
      const t = trimmed.slice(5).trim() as Rule['type'];
      if (!VALID_TYPES.includes(t)) {
        throw new ParseError(`Invalid rule Type "${t}"`, undefined, 'Logic Rules');
      }
      currentRule.type = t;
    } else if (trimmed.startsWith('Entity:')) {
      currentRule.entity = trimmed.slice(7).trim();
    } else if (trimmed.startsWith('Condition:')) {
      const condition = trimmed.slice(10).trim();
      validateCondition(condition, currentRule.id!);
      currentRule.condition = condition;
    } else if (trimmed.startsWith('Message:')) {
      let msg = trimmed.slice(8).trim();
      // Strip surrounding quotes
      if ((msg.startsWith('"') && msg.endsWith('"')) || (msg.startsWith("'") && msg.endsWith("'"))) {
        msg = msg.slice(1, -1);
      }
      currentRule.message = msg;
    } else if (trimmed.startsWith('References:')) {
      const refs = trimmed.slice(11).trim();
      currentRule.references = refs.split(',').map(r => r.trim()).filter(Boolean);
    }
  }

  saveRule();

  return rules;
}
