import { Feature } from '../types';
import { ParseError } from '../errors';

export function parseFeature(content: string): Feature {
  const lines = content.split('\n');
  let name = '';
  const intentLines: string[] = [];
  let foundHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundHeading) {
      if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
        name = trimmed.slice(2).trim();
        foundHeading = true;
      }
    } else {
      // Stop if we hit a ## heading
      if (trimmed.startsWith('## ')) break;
      if (trimmed) intentLines.push(trimmed);
    }
  }

  if (!name) {
    throw new ParseError('Missing feature name (level-1 heading)', undefined, 'feature');
  }

  if (intentLines.length === 0) {
    throw new ParseError('Missing feature intent statement', undefined, 'feature');
  }

  return {
    name,
    intent: intentLines.join(' '),
  };
}
