import { Manifest } from '../types';
import { CodeFile, CodeIndex, ManifestDelta, PlanItem, PlanItemStatus } from './types';
import { extractConditionTerms } from './detectors';

/**
 * Build a refactor plan from the delta between two manifests.
 * Each plan item describes work that needs to be done and whether it's already implemented.
 */
export function buildRefactorPlan(
  delta: ManifestDelta,
  headManifest: Manifest,
  files: CodeFile[],
  index: CodeIndex
): PlanItem[] {
  const plan: PlanItem[] = [];
  let counter = 1;

  function nextId(): string {
    return `RP_${String(counter++).padStart(2, '0')}`;
  }

  // ── Added rules ──────────────────────────────────────────────────────────────
  for (const ruleId of delta.addedRules) {
    const rule = headManifest.rules[ruleId];
    if (!rule) continue;

    const ruleAsAny = rule as any;
    const scopeTargets: string[] = ruleAsAny.scope || [];

    // Determine candidate files from scope
    let candidateFiles: Array<{ file: string; line: number }> = [];
    if (scopeTargets.length > 0) {
      for (const target of scopeTargets) {
        const resolved = index.resolve(target);
        candidateFiles.push(...resolved);
      }
      // Deduplicate
      const seen = new Set<string>();
      candidateFiles = candidateFiles.filter(c => {
        if (seen.has(c.file)) return false;
        seen.add(c.file);
        return true;
      });
    } else {
      // No scope — use all files
      candidateFiles = files.map(f => ({ file: f.path, line: 1 }));
    }

    // Search for condition terms in the candidate files
    const conditionTerms = extractConditionTerms(rule.condition);

    // For security rules, look for the critical actor/field terms
    // For business rules, look for field reference terms
    const searchTerms = getSearchTermsForRule(rule.type, conditionTerms, rule.condition);

    let implementedLocation: { file: string; line: number } | null = null;

    for (const candidate of candidateFiles) {
      const fileContent = index.getFile(candidate.file);
      if (!fileContent) continue;

      const implemented = searchTerms.length > 0 && searchTerms.every(term => {
        return fileContent.toLowerCase().includes(term.toLowerCase());
      });

      if (implemented) {
        // Find actual line number
        const lines = fileContent.split('\n');
        const termLine = findFirstTermLine(lines, searchTerms);
        implementedLocation = {
          file: candidate.file,
          line: termLine !== -1 ? termLine : candidate.line,
        };
        break;
      }
    }

    const status: PlanItemStatus = implementedLocation ? 'implemented' : 'missing';
    const firstCandidate = candidateFiles.length > 0 ? candidateFiles[0] : null;

    plan.push({
      id: nextId(),
      ruleId,
      status,
      description: buildRuleDescription(rule, status, firstCandidate),
      scope: scopeTargets.length > 0 ? scopeTargets : inferScopeFromRule(rule, headManifest),
      location: implementedLocation ?? (firstCandidate && status === 'missing' ? firstCandidate : null),
      fixHint: status === 'missing' ? buildFixHint(rule) : null,
    });
  }

  // ── Added fields ─────────────────────────────────────────────────────────────
  // Group all added fields together for a migration check
  if (delta.addedFields.length > 0) {
    const fieldNames = delta.addedFields.map(f => f.field);
    const entities = [...new Set(delta.addedFields.map(f => f.entity))];

    // Search migration files for the field names
    let migrationLocation: { file: string; line: number } | null = null;

    // Find migration files (files matching db/migrations/* pattern)
    const migrationFiles = files.filter(f =>
      f.path.includes('migration') ||
      f.path.includes('migrations') ||
      /\d{3}_/.test(f.path)
    );

    for (const mf of migrationFiles) {
      // Check if this migration file contains all added field names
      const allFieldsPresent = fieldNames.every(field =>
        mf.content.toLowerCase().includes(field.toLowerCase())
      );

      if (allFieldsPresent) {
        migrationLocation = { file: mf.path, line: 1 };
        break;
      }

      // Check if at least some fields are present
      const someFieldsPresent = fieldNames.some(field =>
        mf.content.toLowerCase().includes(field.toLowerCase())
      );

      if (someFieldsPresent && !migrationLocation) {
        migrationLocation = { file: mf.path, line: 1 };
      }
    }

    const status: PlanItemStatus = migrationLocation ? 'implemented' : 'missing';
    const fieldList = delta.addedFields.map(f => `${f.entity}.${f.field}`).join(' and ');

    plan.push({
      id: nextId(),
      ruleId: null,
      status,
      description: status === 'implemented'
        ? `${fieldList.replace('User.', 'User.')} fields added to database migration.`
        : `Database migration needed for ${fieldList}.`,
      scope: entities.map(e => `Entity(${e})`),
      location: migrationLocation,
      fixHint: status === 'missing'
        ? `Create a database migration to add ${fieldNames.join(', ')} to the ${entities.join(', ')} table.`
        : null,
    });
  }

  // ── Added providers ───────────────────────────────────────────────────────────
  for (const providerName of delta.addedProviders) {
    const provider = headManifest.externalProviders[providerName];
    if (!provider) continue;

    const searchTerms = [providerName, provider.source].filter(Boolean);
    let implLocation: { file: string; line: number } | null = null;

    for (const f of files) {
      const hasProvider = searchTerms.some(term =>
        f.content.toLowerCase().includes(term.toLowerCase())
      );

      if (hasProvider) {
        const lines = f.content.split('\n');
        const termLine = findFirstTermLine(lines, searchTerms);
        implLocation = { file: f.path, line: termLine !== -1 ? termLine : 1 };
        break;
      }
    }

    const status: PlanItemStatus = implLocation ? 'implemented' : 'missing';

    plan.push({
      id: nextId(),
      ruleId: null,
      status,
      description: status === 'implemented'
        ? `${providerName} integration found in codebase.`
        : `${providerName} (${provider.source}) integration not yet implemented.`,
      scope: [],
      location: implLocation,
      fixHint: status === 'missing'
        ? `Integrate ${providerName} from ${provider.source} to provide ${provider.provides}.`
        : null,
    });
  }

  return plan;
}

function getSearchTermsForRule(
  type: string,
  conditionTerms: string[],
  condition: string
): string[] {
  if (type === 'Security') {
    // For security rules, look for session/field terms — not just actor type names
    return conditionTerms.filter(t => {
      // Keep field references, time values, entity references
      if (/^[A-Z][a-zA-Z]+User$/.test(t)) return false; // Skip actor type names like AuthenticatedUser
      if (t === 'System') return false; // Actor type
      return true;
    });
  }

  if (type === 'Business') {
    // For business rules, focus on entity fields
    return conditionTerms.filter(t => t.includes('_') || /^[a-z]/.test(t));
  }

  // Validation
  return conditionTerms;
}

function findFirstTermLine(lines: string[], terms: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (terms.some(t => lines[i].toLowerCase().includes(t.toLowerCase()))) {
      return i + 1;
    }
  }
  return -1;
}

function buildRuleDescription(
  rule: any,
  status: PlanItemStatus,
  location: { file: string; line: number } | null
): string {
  if (status === 'implemented') {
    return `${rule.title} — condition implemented.`;
  }

  const entity = rule.entity || '';
  const condition = rule.condition || '';

  if (rule.type === 'Security') {
    const actorMatch = condition.match(/actor\.type\s*==\s*['"](\w+)['"]/);
    if (actorMatch) {
      const actor = actorMatch[1];
      // Try to find what field is guarded
      const fieldMatch = condition.match(/entity\.(\w+)/);
      const field = fieldMatch ? fieldMatch[1] : null;
      if (field) {
        const file = location?.file ?? 'unknown';
        return `Only actor:${actor} can write ${entity}.${field}. Route in ${file} allows any actor to set ${field}.`;
      }
      return `Route must restrict access to actor:${actor}.`;
    }

    const sessionMatch = condition.match(/Session\.(\w+)/);
    if (sessionMatch) {
      return `${rule.title} not implemented — session check missing in handler.`;
    }
  }

  if (rule.type === 'Business') {
    const fieldMatch = condition.match(/entity\.(\w+)/);
    if (fieldMatch) {
      const file = location?.file ?? 'unknown';
      return `${rule.title} gate not implemented. No route checks entity.${fieldMatch[1]} before granting access.`;
    }
  }

  return `${rule.title} — not yet implemented.`;
}

function buildFixHint(rule: any): string {
  const condition = rule.condition || '';

  if (rule.type === 'Security' && condition.includes("actor.type == 'System'")) {
    return `Add a system-actor check before processing ${rule.entity.toLowerCase()}-related updates.`;
  }

  if (rule.type === 'Security' && condition.includes('Session.created_at')) {
    const intervalMatch = condition.match(/INTERVAL\((\d+),\s*(\w+)\)/);
    if (intervalMatch) {
      return `Add middleware to verify Session.created_at > NOW() - INTERVAL(${intervalMatch[1]}, ${intervalMatch[2]}) before the route handler.`;
    }
  }

  if (rule.type === 'Business') {
    const fieldMatch = condition.match(/entity\.(\w+)/);
    if (fieldMatch) {
      return `Add middleware that checks user.${fieldMatch[1]} == true before ${fieldMatch[1]}-gated route handlers.`;
    }
  }

  return `Implement the condition: ${condition}`;
}

function inferScopeFromRule(rule: any, manifest: Manifest): string[] {
  const scope: string[] = [];
  if (rule.entity) {
    scope.push(`Entity(${rule.entity})`);
  }

  // Look for actor references in condition
  const actorMatch = rule.condition?.match(/actor\.type\s*==\s*['"](\w+)['"]/);
  if (actorMatch) {
    scope.push(`Actor(${actorMatch[1]})`);
  }

  return scope;
}
