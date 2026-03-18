import { Entity, Field, FieldModifier } from '../types';
import { ParseError } from '../errors';

/**
 * Parse modifier args, handling nested parentheses.
 * e.g. "User.id, many-to-one" or "'A', 'B', 'C'" or "PENDING_VERIFICATION"
 */
export function parseModifierArgs(raw: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of raw) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Parse a field line like:
 *   field_name: type | mod | mod(arg) | mod(arg1, arg2)
 *
 * The tricky part: the type itself can contain parens and commas, e.g.
 *   status: enum('PENDING_VERIFICATION', 'ACTIVE') | required | default(PENDING_VERIFICATION)
 *
 * Strategy: split by " | " (space-pipe-space), but be careful about parens.
 */
function splitByPipe(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === '|' && depth === 0) {
      // Check surrounding spaces
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseField(name: string, rest: string): Field {
  // rest is everything after the colon, trimmed
  const parts = splitByPipe(rest);
  const type = parts[0].trim();
  const modifiers: FieldModifier[] = [];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    const parenOpen = part.indexOf('(');
    if (parenOpen !== -1) {
      const parenClose = part.lastIndexOf(')');
      const modName = part.slice(0, parenOpen).trim();
      const argsStr = part.slice(parenOpen + 1, parenClose).trim();
      const args = argsStr ? parseModifierArgs(argsStr) : [];
      modifiers.push({ name: modName, args });
    } else {
      modifiers.push({ name: part, args: [] });
    }
  }

  return { name, type, modifiers };
}

export function parseDataModel(content: string): Record<string, Entity> {
  const entities: Record<string, Entity> = {};
  const lines = content.split('\n');

  let currentEntity: string | null = null;
  let currentFields: Record<string, Field> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('### ')) {
      if (currentEntity) {
        entities[currentEntity] = { fields: currentFields };
      }
      currentEntity = trimmed.slice(4).trim();
      currentFields = {};
      continue;
    }

    if (!currentEntity) continue;

    // Field line: "field_name: ..."
    // Must contain a colon and not start with a heading marker
    if (trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    // Make sure the part before the colon looks like a field name (snake_case)
    const fieldName = trimmed.slice(0, colonIdx).trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(fieldName)) continue;

    const rest = trimmed.slice(colonIdx + 1).trim();
    if (!rest) continue;

    try {
      currentFields[fieldName] = parseField(fieldName, rest);
    } catch (e) {
      throw new ParseError(
        `Failed to parse field "${fieldName}": ${(e as Error).message}`,
        undefined,
        'Data Model'
      );
    }
  }

  if (currentEntity) {
    entities[currentEntity] = { fields: currentFields };
  }

  return entities;
}
