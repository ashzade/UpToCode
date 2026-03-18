import { ComputedProperty } from '../types';
import { ParseError } from '../errors';

const VALID_AGGREGATES = ['COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'EXISTS'] as const;
const WINDOW_REGEX = /^(\d+)(m|h|d) rolling$/;

function parseWindow(raw: string): ComputedProperty['window'] {
  const trimmed = raw.trim();
  if (trimmed === 'none') return null;

  const match = trimmed.match(WINDOW_REGEX);
  if (!match) {
    throw new ParseError(
      `Invalid Window value "${raw}". Expected format: "Nm rolling", "Nh rolling", or "none"`,
      undefined,
      'Computed Properties'
    );
  }

  return {
    value: parseInt(match[1], 10),
    unit: match[2],
    type: 'rolling',
  };
}

export function parseComputed(content: string): Record<string, ComputedProperty> {
  const properties: Record<string, ComputedProperty> = {};
  const lines = content.split('\n');

  let currentProp: string | null = null;
  let current: Partial<ComputedProperty> = {};

  function saveProp() {
    if (currentProp) {
      if (!current.aggregate) throw new ParseError(`Computed property "${currentProp}" missing Aggregate`, undefined, 'Computed Properties');
      if (!current.entity) throw new ParseError(`Computed property "${currentProp}" missing Entity`, undefined, 'Computed Properties');
      if (!current.filter) throw new ParseError(`Computed property "${currentProp}" missing Filter`, undefined, 'Computed Properties');
      if (!('window' in current)) throw new ParseError(`Computed property "${currentProp}" missing Window`, undefined, 'Computed Properties');
      properties[currentProp] = current as ComputedProperty;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('### ')) {
      saveProp();
      currentProp = trimmed.slice(4).trim();
      current = {};
      continue;
    }

    if (!currentProp) continue;

    if (trimmed.startsWith('Aggregate:')) {
      const agg = trimmed.slice(10).trim() as ComputedProperty['aggregate'];
      if (!VALID_AGGREGATES.includes(agg)) {
        throw new ParseError(`Invalid Aggregate "${agg}"`, undefined, 'Computed Properties');
      }
      current.aggregate = agg;
    } else if (trimmed.startsWith('Entity:')) {
      current.entity = trimmed.slice(7).trim();
    } else if (trimmed.startsWith('Filter:')) {
      current.filter = trimmed.slice(7).trim();
    } else if (trimmed.startsWith('Window:')) {
      current.window = parseWindow(trimmed.slice(7).trim());
    }
  }

  saveProp();

  return properties;
}
