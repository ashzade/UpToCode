/**
 * Enriches requirements.md with plain-English descriptions alongside
 * machine-readable syntax. Descriptions are inserted as blockquote lines
 * (> text) immediately after each heading or definition they describe.
 *
 * The parser strips these lines when compiling — they exist for humans only.
 */

import { Manifest } from './types';

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
