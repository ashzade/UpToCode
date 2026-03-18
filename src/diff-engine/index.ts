import { Manifest } from '../types';
import { CodeFile, ContractDiffResult, SpecDriftResult } from './types';
import { buildCodeIndex } from './code-index';
import { detectViolations } from './detectors';
import { diffManifests } from './spec-diff';
import { buildRefactorPlan } from './planner';

export function contractDiff(manifest: Manifest, files: CodeFile[]): ContractDiffResult {
  const index = buildCodeIndex(files);
  const violations = detectViolations(manifest, files, index);
  const allRuleIds = Object.keys(manifest.rules);
  const violatedIds = violations.map(v => v.ruleId);
  const passed = allRuleIds.filter(id => !violatedIds.includes(id));

  return {
    check: 'contract_diff',
    manifestVersion: manifest.meta.version,
    violations,
    passed,
    summary: `${violations.length} violation${violations.length !== 1 ? 's' : ''} found. ${passed.length} rule${passed.length !== 1 ? 's' : ''} passed.`
  };
}

export function specDrift(
  baseManifest: Manifest,
  headManifest: Manifest,
  files: CodeFile[]
): SpecDriftResult {
  const index = buildCodeIndex(files);
  const delta = diffManifests(baseManifest, headManifest);
  const refactorPlan = buildRefactorPlan(delta, headManifest, files, index);
  const completed = refactorPlan.filter(i => i.status === 'implemented').length;
  const pending = refactorPlan.filter(i => i.status !== 'implemented').length;

  return {
    check: 'spec_drift',
    baseVersion: baseManifest.meta.version,
    headVersion: headManifest.meta.version,
    delta,
    refactorPlan,
    progress: { total: refactorPlan.length, completed, pending },
    summary: `${pending} item${pending !== 1 ? 's' : ''} pending. ${completed} item${completed !== 1 ? 's' : ''} implemented.`
  };
}
