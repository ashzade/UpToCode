import { readFileSync } from 'fs';
import { parse } from './index';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: ts-node src/cli.ts <path-to-requirements.md>');
  process.exit(1);
}

const input = readFileSync(filePath, 'utf-8');
const manifest = parse(input);
console.log(JSON.stringify(manifest, null, 2));
