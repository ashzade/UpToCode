import { contractDiff, specDrift } from '../src/diff-engine/index';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import assert from 'assert';

function test(name: string, fn: () => void) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}: ${e}`); process.exitCode = 1; }
}

function loadFixture(relPath: string): string {
  return readFileSync(join(__dirname, 'fixtures', relPath), 'utf-8');
}

function loadManifest(relPath: string): any {
  return JSON.parse(loadFixture(relPath));
}

function loadCodeFiles(dir: string): Array<{ path: string; content: string }> {
  // Recursively load all .ts files from the fixtures code directory
  const base = join(__dirname, 'fixtures', dir);
  const results: Array<{ path: string; content: string }> = [];
  function walk(d: string, prefix: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(d, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.ts')) {
        results.push({
          path: `${prefix}${entry.name}`,
          content: readFileSync(join(d, entry.name), 'utf-8')
        });
      }
    }
  }
  walk(base, '');
  return results;
}

// ── Contract Diff Tests ─────────────────────────────────────────────────────

const violationManifest = loadManifest('violation-rule-missing/manifest.json');
const violationCode = loadCodeFiles('violation-rule-missing/code');
const violationExpected = loadManifest('violation-rule-missing/expected.json');
let cdResult: any;

test('contract_diff: runs without throwing', () => {
  cdResult = contractDiff(violationManifest, violationCode);
});

test('contract_diff: check field is correct', () => {
  assert.strictEqual(cdResult.check, 'contract_diff');
});

test('contract_diff: finds at least one violation', () => {
  assert.ok(cdResult.violations.length >= 1);
});

test('contract_diff: RULE_SEC_01 is violated', () => {
  const v = cdResult.violations.find((v: any) => v.ruleId === 'RULE_SEC_01');
  assert.ok(v, 'RULE_SEC_01 violation not found');
});

test('contract_diff: RULE_SEC_01 severity is CRITICAL', () => {
  const v = cdResult.violations.find((v: any) => v.ruleId === 'RULE_SEC_01');
  assert.strictEqual(v.severity, 'CRITICAL');
});

test('contract_diff: RULE_SEC_01 violation points to routes/users.ts', () => {
  const v = cdResult.violations.find((v: any) => v.ruleId === 'RULE_SEC_01');
  assert.ok(v.location?.file.includes('users.ts'), `Expected users.ts, got ${v.location?.file}`);
});

test('contract_diff: RULE_SEC_01 violation has a fix hint', () => {
  const v = cdResult.violations.find((v: any) => v.ruleId === 'RULE_SEC_01');
  assert.ok(v.fixHint && v.fixHint.length > 0);
});

test('contract_diff: enforcement responses match expected', () => {
  const v = cdResult.violations.find((v: any) => v.ruleId === 'RULE_SEC_01');
  assert.deepStrictEqual(v.enforcement.responses.sort(), ['alert', 'audit_log', 'reject'].sort());
});

test('contract_diff: summary string is correct format', () => {
  assert.ok(cdResult.summary.includes('violation'));
});

// ── Spec Drift Tests ────────────────────────────────────────────────────────

const baseManifest = loadManifest('violation-spec-drift/base/manifest.json');
const headManifest = loadManifest('violation-spec-drift/head/manifest.json');
const headCode = loadCodeFiles('violation-spec-drift/head/code');
const driftExpected = loadManifest('violation-spec-drift/expected.json');
let sdResult: any;

test('spec_drift: runs without throwing', () => {
  sdResult = specDrift(baseManifest, headManifest, headCode);
});

test('spec_drift: check field is correct', () => {
  assert.strictEqual(sdResult.check, 'spec_drift');
});

test('spec_drift: base and head versions correct', () => {
  assert.strictEqual(sdResult.baseVersion, '1.0.0');
  assert.strictEqual(sdResult.headVersion, '1.1.0');
});

test('spec_drift: delta identifies added rules', () => {
  assert.ok(sdResult.delta.addedRules.includes('RULE_02'));
  assert.ok(sdResult.delta.addedRules.includes('RULE_SEC_01'));
});

test('spec_drift: delta identifies added fields', () => {
  const fields = sdResult.delta.addedFields.map((f: any) => f.field);
  assert.ok(fields.includes('is_pro'));
  assert.ok(fields.includes('stripe_status'));
});

test('spec_drift: delta identifies added providers', () => {
  assert.ok(sdResult.delta.addedProviders.includes('StripeService'));
});

test('spec_drift: refactor plan has at least 2 items', () => {
  assert.ok(sdResult.refactorPlan.length >= 2);
});

test('spec_drift: RULE_SEC_01 is in refactor plan as missing', () => {
  const item = sdResult.refactorPlan.find((i: any) => i.ruleId === 'RULE_SEC_01');
  assert.ok(item, 'RULE_SEC_01 not in refactor plan');
  assert.strictEqual(item.status, 'missing');
});

test('spec_drift: migration is detected as implemented', () => {
  const item = sdResult.refactorPlan.find((i: any) => i.status === 'implemented');
  assert.ok(item, 'No implemented items found');
  assert.ok(item.location?.file.includes('migration') || item.location?.file.includes('002'));
});

test('spec_drift: progress totals are consistent', () => {
  const { total, completed, pending } = sdResult.progress;
  assert.strictEqual(completed + pending, total);
});

test('spec_drift: summary string mentions pending items', () => {
  assert.ok(sdResult.summary.includes('pending'));
});
