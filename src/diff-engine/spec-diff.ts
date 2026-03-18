import { Manifest } from '../types';
import { ManifestDelta } from './types';

/**
 * Compare two manifests and return a delta describing what changed.
 */
export function diffManifests(base: Manifest, head: Manifest): ManifestDelta {
  const baseRuleKeys = new Set(Object.keys(base.rules));
  const headRuleKeys = new Set(Object.keys(head.rules));

  const addedRules = [...headRuleKeys].filter(k => !baseRuleKeys.has(k));
  const removedRules = [...baseRuleKeys].filter(k => !headRuleKeys.has(k));

  const modifiedRules: string[] = [];
  for (const key of headRuleKeys) {
    if (baseRuleKeys.has(key)) {
      const br = base.rules[key];
      const hr = head.rules[key];
      if (
        br.condition !== hr.condition ||
        br.type !== hr.type ||
        br.message !== hr.message
      ) {
        modifiedRules.push(key);
      }
    }
  }

  // Fields: compare per entity
  const addedFields: Array<{ entity: string; field: string }> = [];
  const removedFields: Array<{ entity: string; field: string }> = [];

  const allEntities = new Set([
    ...Object.keys(base.dataModel),
    ...Object.keys(head.dataModel),
  ]);

  for (const entity of allEntities) {
    const baseFields = new Set(
      base.dataModel[entity] ? Object.keys(base.dataModel[entity].fields) : []
    );
    const headFields = new Set(
      head.dataModel[entity] ? Object.keys(head.dataModel[entity].fields) : []
    );

    for (const f of headFields) {
      if (!baseFields.has(f)) addedFields.push({ entity, field: f });
    }
    for (const f of baseFields) {
      if (!headFields.has(f)) removedFields.push({ entity, field: f });
    }
  }

  // External providers
  const baseProviderKeys = new Set(Object.keys(base.externalProviders));
  const headProviderKeys = new Set(Object.keys(head.externalProviders));

  const addedProviders = [...headProviderKeys].filter(k => !baseProviderKeys.has(k));
  const removedProviders = [...baseProviderKeys].filter(k => !headProviderKeys.has(k));

  return {
    addedRules,
    removedRules,
    modifiedRules,
    addedFields,
    removedFields,
    addedProviders,
    removedProviders,
  };
}
