import { Manifest } from './types';
import { ParseError } from './errors';
import { parseFrontmatter } from './sections/frontmatter';
import { parseFeature } from './sections/feature';
import { parseProviders } from './sections/providers';
import { parseStateMachine } from './sections/state-machine';
import { parseActors } from './sections/actors';
import { parseDataModel } from './sections/data-model';
import { parseComputed } from './sections/computed';
import { parseRules } from './sections/rules';
import { validate } from './validate';

export { Manifest } from './types';
export { ParseError } from './errors';

export function parse(input: string): Manifest {
  // 1. Extract YAML frontmatter between first --- and second ---
  const fmMatch = input.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    throw new ParseError('Missing YAML frontmatter (expected --- delimiters)', undefined, 'frontmatter');
  }
  const yamlStr = fmMatch[1];
  const afterFrontmatter = input.slice(fmMatch[0].length);

  // 2. Parse frontmatter
  const meta = parseFrontmatter(yamlStr);

  // 3. Parse feature declaration from the content after frontmatter
  const feature = parseFeature(afterFrontmatter);

  // 4. Split remaining content into sections by ## headings
  const sections = splitSections(afterFrontmatter);

  // 5. Parse each section
  const externalProviders = sections['External State Providers']
    ? parseProviders(sections['External State Providers'])
    : {};

  const stateMachine = sections['State Machine']
    ? parseStateMachine(sections['State Machine'])
    : { states: {}, transitions: [] };

  const { actors, enforcement } = sections['Actors & Access']
    ? parseActors(sections['Actors & Access'])
    : { actors: {}, enforcement: [] };

  const dataModel = sections['Data Model']
    ? parseDataModel(sections['Data Model'])
    : {};

  const computedProperties = sections['Computed Properties']
    ? parseComputed(sections['Computed Properties'])
    : {};

  const rules = sections['Logic Rules']
    ? parseRules(sections['Logic Rules'])
    : {};

  const manifest: Manifest = {
    meta,
    feature,
    externalProviders,
    stateMachine,
    actors,
    enforcement,
    dataModel,
    computedProperties,
    rules,
  };

  // 6. Cross-reference validation
  validate(manifest);

  return manifest;
}

/**
 * Split content into named sections by ## headings.
 * Returns a map of section name → section content (including sub-headings).
 */
function splitSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split('\n');

  let currentSection: string | null = null;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match exactly ## headings (not ### or ####)
    if (/^## [^#]/.test(trimmed)) {
      if (currentSection !== null) {
        sections[currentSection] = sectionLines.join('\n');
      }
      currentSection = trimmed.slice(3).trim();
      sectionLines.length = 0;
    } else {
      if (currentSection !== null) {
        sectionLines.push(line);
      }
    }
  }

  if (currentSection !== null) {
    sections[currentSection] = sectionLines.join('\n');
  }

  return sections;
}
