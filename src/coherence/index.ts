import { Manifest } from '../types';
import { CodeFile } from '../diff-engine/types';
import { detectDeadCode } from './dead-code-detector';
import { detectSilentCatches } from './silent-catch-detector';
import { detectEnvScope } from './env-scope-detector';
import { detectDuplicates } from './duplicate-detector';
import { detectTsContractMismatches } from './ts-contract-detector';
import { detectApiCoherence } from './api-coherence-detector';
import { CoherenceScanResult, CoherenceIssue } from './types';

export { CoherenceScanResult, CoherenceIssue, CodeFile };

export async function coherenceScan(
  manifest: Manifest,
  files: CodeFile[]
): Promise<CoherenceScanResult> {
  const issues: CoherenceIssue[] = [
    ...detectDeadCode(files),
    ...detectSilentCatches(files),
    ...detectEnvScope(manifest, files),
    ...detectDuplicates(files),
    ...detectTsContractMismatches(files),
    ...detectApiCoherence(files),
  ];

  const failed = issues.filter(i => i.severity === 'HIGH' || i.severity === 'MEDIUM').length;
  const passed = issues.filter(i => i.severity === 'LOW').length;

  return {
    issues,
    passed,
    failed,
    summary: issues.length === 0
      ? 'No coherence issues found.'
      : `${issues.length} issue(s) found (${failed} actionable, ${passed} advisory).`,
  };
}
