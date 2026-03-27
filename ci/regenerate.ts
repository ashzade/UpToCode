/**
 * UpToCode CI regenerate script.
 *
 * Recompiles manifest.json from requirements.md and regenerates README.md.
 * Runs on every push to main/master so committed artifacts stay in sync.
 *
 * Note: generate-spec (the LLM step) is NOT called here — requirements.md
 * is already the source of truth. This script only recompiles the artifacts
 * that are derived from it deterministically.
 *
 * Usage:
 *   PROJECT_ROOT=/path/to/project ts-node --transpile-only ci/regenerate.ts
 *
 * Exit codes:
 *   0 = success (or no requirements.md found — not an error)
 *   1 = parse error or file I/O failure
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '../src/index';
import { buildReadmeFromManifest } from '../src/interview/readme-generator';

async function main() {
  const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
  const requirementsPath = path.join(projectRoot, 'requirements.md');
  const manifestPath = path.join(projectRoot, 'manifest.json');
  const readmePath = path.join(projectRoot, 'README.md');

  if (!fs.existsSync(requirementsPath)) {
    console.log('UpToCode regenerate: no requirements.md found — skipping.');
    process.exit(0);
  }

  const requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');

  console.log('UpToCode regenerate: compiling manifest.json…');
  const manifest = parse(requirementsContent);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log('  → manifest.json');

  console.log('UpToCode regenerate: generating README.md…');
  const readme = buildReadmeFromManifest(manifest);
  fs.writeFileSync(readmePath, readme, 'utf-8');
  console.log('  → README.md');

  console.log('UpToCode regenerate: done.');
}

main().catch(err => {
  console.error('UpToCode regenerate error:', err);
  process.exit(1);
});
