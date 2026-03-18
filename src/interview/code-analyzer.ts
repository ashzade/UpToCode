/**
 * Static code analyzer for the Interview Agent.
 *
 * Extracts structural facts from a codebase without calling any AI:
 * entities, routes, state machines, env vars, external API clients, auth patterns.
 *
 * Output feeds the spec-generator prompt so Claude has concrete code evidence
 * to work from rather than hallucinating structure.
 */

export interface CodeFact {
  kind:
    | 'entity'        // table / model / dataclass
    | 'route'         // HTTP endpoint
    | 'state_field'   // field with enum-like status values
    | 'env_var'       // os.getenv / process.env reference
    | 'external_api'  // import of a known external client
    | 'auth_pattern'  // role/auth middleware reference
    | 'transition'    // explicit status assignment ('pending' → 'processed')
    | 'function';     // top-level function that processes data
  name: string;
  detail?: string;     // extra context (e.g. field list, route path, enum values)
  file: string;
  line: number;
}

export interface CodeAnalysis {
  facts: CodeFact[];
  /** Deduplicated entity names found */
  entityNames: string[];
  /** All env var names referenced */
  envVarNames: string[];
  /** All external API names (e.g. 'anthropic', 'google', 'slack') */
  externalApis: string[];
  /** HTTP route patterns found */
  routes: Array<{ method: string; path: string; file: string; line: number }>;
  /** Status field with its known values */
  statusEnums: Array<{ field: string; values: string[] }>;
}

// ── External API detection ────────────────────────────────────────────────────

const KNOWN_APIS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\banthrop/i,        name: 'anthropic' },
  { pattern: /\bopenai\b/i,       name: 'openai' },
  { pattern: /\bgoogle[.\-_]/i,   name: 'google' },
  { pattern: /\bslack\b/i,        name: 'slack' },
  { pattern: /\bstripe\b/i,       name: 'stripe' },
  { pattern: /\btwilio\b/i,       name: 'twilio' },
  { pattern: /\bsendgrid\b/i,     name: 'sendgrid' },
  { pattern: /\baws|boto3\b/i,    name: 'aws' },
  { pattern: /\bazure\b/i,        name: 'azure' },
  { pattern: /\bgithub\b/i,       name: 'github' },
  { pattern: /\blinear\b/i,       name: 'linear' },
];

// ── Route detection ───────────────────────────────────────────────────────────

const ROUTE_PATTERNS: Array<{ re: RegExp; lang: 'python' | 'ts-js' }> = [
  // Flask: @app.route('/path', methods=['GET'])
  { re: /@\w+\.route\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods=\[([^\]]*)\])?/, lang: 'python' },
  // Express: router.get('/path', ...) or app.post('/path', ...)
  { re: /(?:router|app)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/, lang: 'ts-js' },
];

// ── Main analyzer ─────────────────────────────────────────────────────────────

export function analyzeCode(
  files: Array<{ path: string; content: string }>
): CodeAnalysis {
  const facts: CodeFact[] = [];
  const entitySet = new Set<string>();
  const envVarSet = new Set<string>();
  const externalApiSet = new Set<string>();
  const routes: CodeAnalysis['routes'] = [];
  const statusValues = new Map<string, Set<string>>();

  for (const file of files) {
    const lines = file.content.split('\n');
    const isPython = file.path.endsWith('.py');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // ── Entities: Python class definitions ──
      const pyClass = trimmed.match(/^class\s+(\w+)\s*(?:\(([^)]*)\))?:/);
      if (isPython && pyClass) {
        const name = pyClass[1];
        const parent = pyClass[2] || '';
        if (!/^(Exception|Error|Base|Test|Mixin)/i.test(name)) {
          facts.push({ kind: 'entity', name, detail: parent || undefined, file: file.path, line: lineNum });
          entitySet.add(name);
        }
      }

      // ── Entities: SQLite CREATE TABLE ──
      const createTable = trimmed.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/i);
      if (createTable) {
        const name = toPascalCase(createTable[1]);
        facts.push({ kind: 'entity', name, detail: `table: ${createTable[1]}`, file: file.path, line: lineNum });
        entitySet.add(name);
      }

      // ── Entities: TypeScript interface/type ──
      const tsInterface = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (!isPython && tsInterface) {
        const name = tsInterface[1];
        if (!/^(I[A-Z]|Props|State|Config|Options|Request|Response)/i.test(name)) {
          facts.push({ kind: 'entity', name, file: file.path, line: lineNum });
          entitySet.add(name);
        }
      }

      // ── Routes: Flask and Express ──
      for (const { re, lang } of ROUTE_PATTERNS) {
        const m = trimmed.match(re);
        if (m) {
          if (lang === 'python') {
            const path = m[1];
            const methods = m[2]
              ? m[2].replace(/['"]/g, '').split(',').map(s => s.trim().toUpperCase())
              : ['GET'];
            for (const method of methods) {
              routes.push({ method, path, file: file.path, line: lineNum });
              facts.push({ kind: 'route', name: `${method} ${path}`, file: file.path, line: lineNum });
            }
          } else {
            const method = m[1].toUpperCase();
            const path = m[2];
            routes.push({ method, path, file: file.path, line: lineNum });
            facts.push({ kind: 'route', name: `${method} ${path}`, file: file.path, line: lineNum });
          }
          break;
        }
      }

      // ── Env vars: os.getenv / os.environ / process.env ──
      const envPy = trimmed.matchAll(/os\.(?:getenv|environ\.get)\(['"]([^'"]+)['"]/g);
      for (const m of envPy) {
        envVarSet.add(m[1]);
        facts.push({ kind: 'env_var', name: m[1], file: file.path, line: lineNum });
      }
      const envNode = trimmed.matchAll(/process\.env\.([A-Z_][A-Z0-9_]+)/g);
      for (const m of envNode) {
        envVarSet.add(m[1]);
        facts.push({ kind: 'env_var', name: m[1], file: file.path, line: lineNum });
      }

      // ── External APIs: import statements ──
      const importLine = trimmed.match(/^(?:import|from)\s+([\w.]+)/) ||
                         trimmed.match(/require\s*\(\s*['"]([^'"]+)['"]/);
      if (importLine) {
        const mod = importLine[1].toLowerCase();
        for (const { pattern, name } of KNOWN_APIS) {
          if (pattern.test(mod) && !externalApiSet.has(name)) {
            externalApiSet.add(name);
            facts.push({ kind: 'external_api', name, detail: importLine[1], file: file.path, line: lineNum });
          }
        }
      }

      // ── State transitions: status = 'value' ──
      const statusAssign = trimmed.match(/\b(\w*status\w*)\s*[=:]\s*['"]([a-z_]+)['"]/i);
      if (statusAssign) {
        const field = statusAssign[1].toLowerCase();
        const value = statusAssign[2];
        if (!statusValues.has(field)) statusValues.set(field, new Set());
        statusValues.get(field)!.add(value);
      }

      // ── Transitions: explicit status change in code ──
      const transitionPy = trimmed.match(
        /['"]status['"]\s*[:=]\s*['"](\w+)['"]/i
      );
      if (transitionPy) {
        facts.push({ kind: 'transition', name: transitionPy[1], file: file.path, line: lineNum });
      }

      // ── Auth patterns ──
      const authPatterns = [
        /@login_required/,
        /require_permission/i,
        /is_admin/i,
        /verify_jwt/i,
        /authenticate\s*\(/i,
        /current_user/i,
        /g\.user/,
        /req\.(user|auth)\./,
        /passport\.authenticate/i,
      ];
      if (authPatterns.some(p => p.test(trimmed))) {
        facts.push({ kind: 'auth_pattern', name: trimmed.slice(0, 60), file: file.path, line: lineNum });
      }

      // ── Key processing functions ──
      if (isPython) {
        const defMatch = trimmed.match(/^def\s+(process_\w+|analyze_\w+|handle_\w+|run_\w+|generate_\w+)\s*\(/);
        if (defMatch) {
          facts.push({ kind: 'function', name: defMatch[1], file: file.path, line: lineNum });
        }
      }
    }
  }

  // Build statusEnums from collected assignments
  const statusEnums: CodeAnalysis['statusEnums'] = [];
  for (const [field, values] of statusValues) {
    if (values.size >= 2) {
      statusEnums.push({ field, values: [...values] });
    }
  }

  return {
    facts,
    entityNames: [...entitySet],
    envVarNames: [...envVarSet],
    externalApis: [...externalApiSet],
    routes,
    statusEnums,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toPascalCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
          .replace(/^[a-z]/, c => c.toUpperCase());
}
