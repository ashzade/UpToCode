/**
 * UpToCode adversarial test generator — CI script.
 *
 * Generates adversarial test cases from the manifest and writes
 * adversarial-tests.md to the project root for review.
 *
 * Runs nightly via schedule or on demand via workflow_dispatch.
 * Not part of the per-push inspection (too slow for every commit).
 *
 * Usage:
 *   PROJECT_ROOT=/path/to/project ts-node --transpile-only ci/generate-tests.ts
 *
 * Exit codes:
 *   0 = success
 *   1 = error
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateTests, renderMarkdown } from '../src/adversarial/test-generator';
import { Manifest } from '../src/types';

async function main() {
  const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
  const manifestPath = path.join(projectRoot, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error('UpToCode: no manifest.json found — skipping test generation');
    process.exit(0);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log('UpToCode: generating adversarial tests…');

  const testSuite = generateTests(manifest);
  const highTests = testSuite.tests.filter(t => t.severity === 'HIGH').length;

  const outputPath = path.join(projectRoot, 'adversarial-tests.md');
  fs.writeFileSync(outputPath, renderMarkdown(testSuite));

  console.log(`UpToCode: ${testSuite.tests.length} test cases generated (${highTests} high-severity)`);
  console.log(`  → adversarial-tests.md`);
}

main().catch(err => {
  console.error('UpToCode generate-tests error:', err);
  process.exit(1);
});
