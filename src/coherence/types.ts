export interface CoherenceIssue {
  id: string;           // e.g. 'dead-export', 'silent-catch', 'env-scope'
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  file: string;
  line?: number;
  message: string;
  detail: string;
  fixHint: string;
}

export interface CoherenceScanResult {
  issues: CoherenceIssue[];
  passed: number;
  failed: number;
  summary: string;
}
