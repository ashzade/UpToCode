import { Manifest } from '../types';

export interface CodeFile {
  path: string;        // relative path, e.g. "routes/users.ts"
  content: string;
}

// ── Contract Diff ──────────────────────────────────────────────

export interface Violation {
  ruleId: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  scopeTargets: string[];
  location: { file: string; line: number } | null;
  condition: string;
  fixHint: string;
  enforcement: { responses: string[] };
}

export interface ContractDiffResult {
  check: 'contract_diff';
  manifestVersion: string;
  violations: Violation[];
  passed: string[];   // rule IDs that passed
  summary: string;
}

// ── Spec Drift ─────────────────────────────────────────────────

export interface ManifestDelta {
  addedRules: string[];
  removedRules: string[];
  modifiedRules: string[];
  addedFields: Array<{ entity: string; field: string }>;
  removedFields: Array<{ entity: string; field: string }>;
  addedProviders: string[];
  removedProviders: string[];
}

export type PlanItemStatus = 'missing' | 'implemented' | 'partial';

export interface PlanItem {
  id: string;
  ruleId: string | null;
  status: PlanItemStatus;
  description: string;
  scope: string[];
  location: { file: string; line: number } | null;
  fixHint: string | null;
}

export interface SpecDriftResult {
  check: 'spec_drift';
  baseVersion: string;
  headVersion: string;
  delta: ManifestDelta;
  refactorPlan: PlanItem[];
  progress: { total: number; completed: number; pending: number };
  summary: string;
}

// ── Code Index ─────────────────────────────────────────────────

export interface CodeIndex {
  // semantic target string → array of { file, line } matches
  resolve(target: string): Array<{ file: string; line: number }>;
  // find all lines in all files matching a regex
  grep(pattern: RegExp): Array<{ file: string; line: number; text: string }>;
  // get content of a specific file
  getFile(path: string): string | null;
}
