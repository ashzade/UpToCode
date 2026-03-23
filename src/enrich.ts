/**
 * Enriches requirements.md with plain-English descriptions alongside
 * machine-readable syntax. Descriptions are inserted as blockquote lines
 * (> text) immediately after each heading or definition they describe.
 *
 * The parser strips these lines when compiling — they exist for humans only.
 */

import { Manifest } from './types';

/**
 * Migrates scope data from an existing manifest.json into requirements.md.
 * Called before parsing so that scopes are compiled into the new manifest
 * and never lost again. Only injects scopes that aren't already present.
 */
export function injectScopes(
  content: string,
  existingRules: Record<string, { scope?: string[] }>,
): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    output.push(line);

    // Rule heading: #### RULE_XX: Title
    const ruleMatch = trimmed.match(/^#### (RULE_\d+):/);
    if (ruleMatch) {
      const ruleId = ruleMatch[1];
      const existingScope = existingRules[ruleId]?.scope;
      if (existingScope && existingScope.length > 0) {
        // Look ahead — check if Scope: is already present within the next ~8 lines
        const lookahead = lines.slice(i + 1, i + 9).map(l => l.trim());
        const alreadyHasScope = lookahead.some(l => l.startsWith('Scope:'));
        if (!alreadyHasScope) {
          // Find where to insert: after Type/Entity lines, before Condition
          // We'll insert it by scanning forward until we hit Condition: or Message:
          const insertLines: string[] = [];
          i++;
          while (i < lines.length) {
            const ahead = lines[i].trim();
            if (ahead.startsWith('Condition:') || ahead.startsWith('Message:')) {
              // Normalise scope values: strip File() wrapper if present
              const normalised = existingScope.map(s => s.replace(/^File\((.+)\)$/, '$1'));
              output.push(`Scope: ${normalised.join(', ')}`);
              output.push(...insertLines);
              break;
            }
            insertLines.push(lines[i]);
            i++;
          }
          continue;
        }
      }
    }

    i++;
  }

  return output.join('\n');
}

/**
 * Injects or updates `> description` lines in requirements.md.
 * Descriptions are derived deterministically from the compiled manifest —
 * no AI call required.
 */
export function enrichRequirements(content: string, manifest: Manifest): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let currentSection = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track current ## section
    if (/^## [^#]/.test(trimmed)) {
      currentSection = trimmed.slice(3).trim();
    }

    output.push(line);

    const description = descriptionFor(trimmed, currentSection, manifest);

    if (description !== null) {
      i++;
      // Skip any existing blank lines and `> ` description lines right after
      while (
        i < lines.length &&
        (lines[i].trim() === '' || lines[i].trim().startsWith('> '))
      ) {
        i++;
      }
      output.push(`> ${description}`);
      output.push('');
    } else {
      i++;
    }
  }

  return output.join('\n');
}

function descriptionFor(
  trimmed: string,
  section: string,
  manifest: Manifest,
): string | null {
  // ── Logic Rules: #### RULE_XX: Title ─────────────────────────────────────
  const ruleMatch = trimmed.match(/^#### (RULE_\d+):/);
  if (ruleMatch) {
    const rule = manifest.rules[ruleMatch[1]];
    if (rule?.message) return rule.message;
  }

  // ── State Machine: #### FROM → TO ─────────────────────────────────────────
  const transMatch = trimmed.match(/^#### (.+?) → (.+)/);
  if (transMatch) {
    const from = transMatch[1].trim();
    const to = transMatch[2].trim();
    const t = manifest.stateMachine?.transitions?.find(
      x => x.from === from && x.to === to,
    );
    if (t?.trigger) {
      const trigger = t.trigger.charAt(0).toUpperCase() + t.trigger.slice(1);
      return `${trigger}.`;
    }
    return `Moves from ${from} to ${to}.`;
  }

  // ── External Providers: ### ProviderName ──────────────────────────────────
  if (section === 'External State Providers' && /^### \w/.test(trimmed)) {
    const name = trimmed.slice(4).trim();
    const provider = manifest.externalProviders[name];
    if (provider?.provides) {
      const scopeNote = provider.scopes?.length
        ? ` Requires scopes: ${provider.scopes.join(', ')}.`
        : '';
      return `Used for: ${provider.provides}.${scopeNote}`;
    }
  }

  // ── Data Model: ### EntityName ────────────────────────────────────────────
  if (section === 'Data Model' && /^### \w/.test(trimmed)) {
    const name = trimmed.slice(4).trim();
    const entity = manifest.dataModel[name];
    if (entity) {
      // Detect in-memory entities from the Note line (they won't have a
      // `persisted` flag in the current type, so use a heuristic: the
      // requirements.md note says "(in-memory)")
      const isInMemory = trimmed.includes('(in-memory)');
      return isInMemory
        ? 'Temporary data used during processing — not saved to the database.'
        : 'Saved to the database.';
    }
  }

  return null;
}
