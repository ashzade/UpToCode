import { Meta } from '../types';
import { ParseError } from '../errors';

const VALID_STATUSES = ['draft', 'review', 'approved', 'deprecated'] as const;

export function parseFrontmatter(yaml: string): Meta {
  const lines = yaml.split('\n');
  const data: Record<string, string | string[]> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') { i++; continue; }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (value === '') {
      // list follows
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const listLine = lines[i].trim();
        if (listLine.startsWith('- ')) {
          items.push(listLine.slice(2).trim());
          i++;
        } else {
          break;
        }
      }
      data[key] = items;
    } else {
      data[key] = value;
      i++;
    }
  }

  // Validate required keys
  const required = ['feature_id', 'version', 'status', 'owner'];
  for (const req of required) {
    if (!(req in data)) {
      throw new ParseError(`Missing required frontmatter key: ${req}`, undefined, 'frontmatter');
    }
  }

  const status = data['status'] as string;
  if (!VALID_STATUSES.includes(status as any)) {
    throw new ParseError(
      `Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`,
      undefined,
      'frontmatter'
    );
  }

  return {
    featureId: data['feature_id'] as string,
    version: data['version'] as string,
    status: status as Meta['status'],
    owner: data['owner'] as string,
    dependsOn: (data['depends_on'] as string[]) || [],
    tags: (data['tags'] as string[]) || [],
  };
}
