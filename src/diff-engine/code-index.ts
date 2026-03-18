import { CodeFile, CodeIndex } from './types';

/**
 * Build a code index from an array of CodeFile objects.
 * The index supports semantic target resolution and full-text grep.
 */
export function buildCodeIndex(files: CodeFile[]): CodeIndex {
  // Pre-split files into lines for efficient scanning
  const fileLines: Map<string, string[]> = new Map();
  for (const f of files) {
    fileLines.set(f.path, f.content.split('\n'));
  }

  return {
    resolve(target: string): Array<{ file: string; line: number }> {
      return resolveTarget(target, files, fileLines);
    },

    grep(pattern: RegExp): Array<{ file: string; line: number; text: string }> {
      const results: Array<{ file: string; line: number; text: string }> = [];
      for (const [path, lines] of fileLines) {
        lines.forEach((text, idx) => {
          if (pattern.test(text)) {
            results.push({ file: path, line: idx + 1, text });
          }
        });
      }
      return results;
    },

    getFile(path: string): string | null {
      const f = files.find(f => f.path === path);
      return f ? f.content : null;
    }
  };
}

function resolveTarget(
  target: string,
  files: CodeFile[],
  fileLines: Map<string, string[]>
): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];

  // Actor(Name)
  const actorMatch = target.match(/^Actor\((.+)\)$/);
  if (actorMatch) {
    const name = actorMatch[1];
    return resolveActor(name, fileLines);
  }

  // Entity(Name)
  const entityMatch = target.match(/^Entity\((.+)\)$/);
  if (entityMatch) {
    const name = entityMatch[1];
    return resolveEntity(name, fileLines);
  }

  // Route(pattern)
  const routeMatch = target.match(/^Route\((.+)\)$/);
  if (routeMatch) {
    const pattern = routeMatch[1];
    return resolveRoute(pattern, fileLines);
  }

  // Transition(FROM → TO)  — arrow may be unicode → or ASCII ->
  const transitionMatch = target.match(/^Transition\((.+?)\s*(?:→|->)\s*(.+)\)$/);
  if (transitionMatch) {
    const from = transitionMatch[1].trim();
    const to = transitionMatch[2].trim();
    return resolveTransition(from, to, fileLines);
  }

  return results;
}

function resolveActor(
  name: string,
  fileLines: Map<string, string[]>
): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];
  const nameLower = name.toLowerCase();

  // Patterns to search for actor names
  const patterns = [
    new RegExp(`['"]${escapeRegex(name)}['"]`, 'i'),       // 'AuthenticatedUser' or "admin"
    new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),          // identifier: AuthenticatedUser
    new RegExp(`require${escapeRegex(capitalize(name))}`, 'i'), // requireAuth
    new RegExp(`ensure${escapeRegex(capitalize(name))}`, 'i'),  // ensureAuthenticated
    new RegExp(`is${escapeRegex(capitalize(name))}`, 'i'),       // isAdmin
  ];

  for (const [path, lines] of fileLines) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (patterns.some(p => p.test(line))) {
        results.push({ file: path, line: i + 1 });
        break; // one result per file
      }
    }
  }

  return results;
}

function resolveEntity(
  name: string,
  fileLines: Map<string, string[]>
): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];
  const nameLower = name.toLowerCase();

  const patterns = [
    new RegExp(`import\\s+.*\\b${escapeRegex(name)}\\b`, 'i'),         // import User from / import { User }
    new RegExp(`\\b${escapeRegex(name)}\\.findBy`, 'i'),                // User.findById
    new RegExp(`\\b${escapeRegex(name)}\\.`, 'i'),                      // User.something
    new RegExp(`db\\.${escapeRegex(nameLower)}`, 'i'),                  // db.users
    new RegExp(`['"]${escapeRegex(nameLower)}['"]`, 'i'),               // table name as string
    new RegExp(`class\\s+${escapeRegex(name)}\\s*[:(]`, 'i'),          // Python: class User(Model):
    new RegExp(`def\\s+upsert_${escapeRegex(nameLower)}`, 'i'),        // Python: def upsert_document
    new RegExp(`INSERT INTO\\s+${escapeRegex(nameLower)}`, 'i'),       // SQL INSERT INTO documents
    new RegExp(`SELECT.*FROM\\s+${escapeRegex(nameLower)}`, 'i'),      // SQL SELECT ... FROM documents
  ];

  for (const [path, lines] of fileLines) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (patterns.some(p => p.test(line))) {
        results.push({ file: path, line: i + 1 });
        break;
      }
    }
  }

  return results;
}

function resolveRoute(
  pattern: string,
  fileLines: Map<string, string[]>
): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];

  // Convert glob pattern to regex: /api/users/* → matches /api/users/:id, /api/users/list
  const regexStr = escapeRegex(pattern)
    .replace(/\\\*/g, '[^/]+')     // * → match single path segment
    .replace(/:[^/]+/g, '[^/]+');  // :param → match param

  // Express route pattern
  const expressPattern = new RegExp(
    `(router|app)\\.(get|post|put|patch|delete|use)\\(\\s*['"\`]${regexStr}['"\`]`,
    'i'
  );

  // Flask route decorator pattern: @app.route('/path') or @bp.route('/path')
  const flaskPattern = new RegExp(
    `@\\w+\\.route\\(\\s*['"]${regexStr}['"]`,
    'i'
  );

  for (const [path, lines] of fileLines) {
    for (let i = 0; i < lines.length; i++) {
      if (expressPattern.test(lines[i]) || flaskPattern.test(lines[i])) {
        results.push({ file: path, line: i + 1 });
        break;
      }
    }
  }

  return results;
}

function resolveTransition(
  from: string,
  to: string,
  fileLines: Map<string, string[]>
): Array<{ file: string; line: number }> {
  const results: Array<{ file: string; line: number }> = [];

  // Generate keyword variants from FROM/TO names
  const fromKeywords = transitionKeywords(from);
  const toKeywords = transitionKeywords(to);

  const allKeywords = [...fromKeywords, ...toKeywords];

  for (const [path, lines] of fileLines) {
    let matchLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLC = line.toLowerCase();
      if (allKeywords.some(kw => lineLC.includes(kw.toLowerCase()))) {
        if (matchLine === -1) matchLine = i + 1;
      }
    }
    if (matchLine !== -1) {
      results.push({ file: path, line: matchLine });
    }
  }

  return results;
}

function transitionKeywords(stateName: string): string[] {
  // LOCKED → [unlock, LOCKED, locked]
  const lower = stateName.toLowerCase();
  const keywords: string[] = [stateName, lower];

  // Strip common prefixes/suffixes and generate verb forms
  const stripped = lower
    .replace(/^(in_|is_|has_)/, '')
    .replace(/(_ed|_ing)$/, '');

  if (stripped !== lower) keywords.push(stripped);

  // Common transformation verbs
  const verbMap: Record<string, string[]> = {
    locked: ['unlock', 'lock'],
    active: ['activate', 'reactivate'],
    inactive: ['deactivate'],
    pending: ['pending'],
    verified: ['verify'],
    published: ['publish'],
    draft: ['draft'],
  };

  const verbs = verbMap[lower] || [];
  keywords.push(...verbs);

  return [...new Set(keywords)];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
