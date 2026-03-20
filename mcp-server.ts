import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parse } from './src/index';
import { contractDiff, specDrift } from './src/diff-engine/index';
import { CodeFile } from './src/diff-engine/types';
import { Manifest } from './src/types';
import { analyzeCode } from './src/interview/code-analyzer';
import { generateSpec } from './src/interview/spec-generator';
import { generateTests, renderMarkdown } from './src/adversarial/test-generator';
import { securityAudit, renderSecurityReport } from './src/security/access-auditor';
import { runScaleMonitor, renderScaleReport } from './src/scale/monitor';
import { buildInterviewPrompt, buildSpecFromTranscript, InterviewTranscript } from './src/interview/interviewer';

// ── Schema definitions ──────────────────────────────────────────

const CompileSpecInput = z.object({
  project_root: z.string().optional().describe('Absolute path to the project directory. When provided, requirements.md is read from this directory and manifest.json is written here.'),
  requirements_path: z.string().optional().describe('Absolute path to requirements.md. Overrides project_root discovery.'),
});

const CheckIntegrityInput = z.object({
  project_root: z.string().optional().describe('Absolute path to the project directory containing requirements.md and manifest.json.'),
  requirements_path: z.string().optional().describe('Absolute path to requirements.md. Overrides project_root.'),
});

const ContractDiffInput = z.object({
  project_root: z.string().optional().describe('Absolute path to the project directory. When provided, manifest.json is read from here and all code files (.py, .ts, .js) are scanned recursively.'),
  manifest_path: z.string().optional().describe('Absolute path to manifest.json. Overrides project_root discovery.'),
  code_paths: z.array(z.string()).optional().describe('Explicit list of absolute paths to code files. Overrides project_root file discovery.'),
});

const SpecDriftInput = z.object({
  base_manifest_path: z.string(),
  head_manifest_path: z.string(),
  code_paths: z.array(z.string()),
});

const StartInterviewInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory where requirements.md will be written'),
  context: z.string().optional().describe('Any context you already know about the project'),
});

const FinishInterviewInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory'),
  what: z.string().describe('What the app does'),
  users: z.string().describe('Who uses the app and their roles'),
  main_thing: z.string().describe('The main things the app tracks or stores'),
  fields: z.string().describe('What information is stored about each thing'),
  states: z.string().describe('Stages or statuses things go through'),
  actions: z.string().describe('Key actions users can take'),
  rules: z.string().describe('Rules the app must enforce'),
  external: z.string().describe('Outside services the app connects to'),
  env_vars: z.string().describe('Secret keys and environment variables needed'),
  feature_name: z.string().optional().describe('Name of the feature or app'),
  owner: z.string().optional().describe('Owner name or handle'),
  output_path: z.string().optional().describe('Where to write requirements.md. Defaults to <project_root>/requirements.md'),
});

const ScaleMonitorInput = z.object({
  project_root: z.string().optional().describe('Project directory — manifest.json and *.db file are auto-discovered here'),
  manifest_path: z.string().optional().describe('Explicit path to manifest.json'),
  db_path: z.string().optional().describe('Explicit path to SQLite database file'),
  output_path: z.string().optional().describe('Where to write the report. Defaults to <project_root>/scale-report.md'),
});

const SecurityAuditInput = z.object({
  project_root: z.string().optional().describe('Project directory containing manifest.json and code files'),
  manifest_path: z.string().optional().describe('Explicit path to manifest.json'),
  code_paths: z.array(z.string()).optional().describe('Explicit list of code files. Overrides project_root discovery.'),
  output_path: z.string().optional().describe('Where to write the security report. Defaults to <project_root>/security-audit.md'),
});

const GenerateTestsInput = z.object({
  project_root: z.string().optional().describe('Project directory containing manifest.json'),
  manifest_path: z.string().optional().describe('Explicit path to manifest.json'),
  output_path: z.string().optional().describe('Where to write the test report. Defaults to <project_root>/adversarial-tests.md'),
});

const GenerateSpecInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory to analyze'),
  description: z.string().optional().describe('Natural language description of what the feature does'),
  feature_name: z.string().optional().describe('Human-readable feature name (e.g. "Document Processing")'),
  owner: z.string().optional().describe('Owner name or handle'),
  output_path: z.string().optional().describe('Where to write requirements.md. Defaults to <project_root>/requirements.md'),
});

// ── Helper: walk project files ──────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);

function walkCodeFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      results.push(...walkCodeFiles(full));
    } else if (entry.isFile() && /\.(py|ts|js)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Helper: deep equal ──────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function topLevelDiffSummary(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  const allKeys = Array.from(new Set([...aKeys, ...bKeys]));
  const diffKeys = allKeys.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (diffKeys.length === 0) return '(no top-level differences detected)';
  return `Differing keys: ${diffKeys.join(', ')}`;
}

// ── MCP Server ──────────────────────────────────────────────────

const server = new Server(
  { name: 'uptocode', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'start-interview',
        description:
          'Start a conversational interview to build requirements.md from scratch. Returns a prompt for Claude to ask the user plain-English questions one at a time — no technical knowledge required. When all answers are collected, call finish-interview to generate the spec.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Where requirements.md will be written' },
            context: { type: 'string', description: 'Any context already known about the project' },
          },
          required: ['project_root'],
        },
      },
      {
        name: 'finish-interview',
        description:
          'Takes the collected interview answers and generates a valid requirements.md using Claude. Validates it parses cleanly and writes it to the project. Call this after start-interview once all questions have been answered.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string' },
            what: { type: 'string' },
            users: { type: 'string' },
            main_thing: { type: 'string' },
            fields: { type: 'string' },
            states: { type: 'string' },
            actions: { type: 'string' },
            rules: { type: 'string' },
            external: { type: 'string' },
            env_vars: { type: 'string' },
            feature_name: { type: 'string' },
            owner: { type: 'string' },
            output_path: { type: 'string' },
          },
          required: ['project_root', 'what', 'users', 'main_thing', 'fields', 'states', 'actions', 'rules', 'external', 'env_vars'],
        },
      },
      {
        name: 'compile-spec',
        description:
          'Parse requirements.md and write manifest.json alongside it. Pass project_root to auto-discover requirements.md in the project directory (e.g. /Users/you/myproject). Run whenever requirements.md changes.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: {
              type: 'string',
              description: 'Absolute path to the project directory containing requirements.md',
            },
            requirements_path: {
              type: 'string',
              description: 'Explicit absolute path to requirements.md (overrides project_root)',
            },
          },
        },
      },
      {
        name: 'check-integrity',
        description:
          'Verify that manifest.json is in sync with requirements.md. Pass project_root to auto-discover both files. Fails if manifest is stale or tampered.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: {
              type: 'string',
              description: 'Absolute path to the project directory containing requirements.md and manifest.json',
            },
            requirements_path: {
              type: 'string',
              description: 'Explicit absolute path to requirements.md (overrides project_root)',
            },
          },
        },
      },
      {
        name: 'contract-diff',
        description:
          'Check whether code satisfies all rules in manifest.json. Pass project_root to auto-discover manifest.json and scan all .py/.ts/.js files recursively. Returns violations with locations and fix hints.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: {
              type: 'string',
              description: 'Absolute path to the project directory. manifest.json and all code files are auto-discovered.',
            },
            manifest_path: {
              type: 'string',
              description: 'Explicit absolute path to manifest.json (overrides project_root)',
            },
            code_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicit list of code files to check (overrides project_root file discovery)',
            },
          },
        },
      },
      {
        name: 'scale-monitor',
        description:
          'Query a live SQLite database and evaluate health checks derived from the manifest: entity state distribution, computed property values, FK integrity, and record volumes. Pass project_root to auto-discover manifest.json and the .db file. Flags backlogs, failure rates, and orphaned records.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Project directory — manifest.json and *.db file are auto-discovered here' },
            manifest_path: { type: 'string', description: 'Explicit path to manifest.json' },
            db_path: { type: 'string', description: 'Explicit path to SQLite database file' },
            output_path: { type: 'string', description: 'Output path for the report (default: <project_root>/scale-report.md)' },
          },
        },
      },
      {
        name: 'security-audit',
        description:
          'Scan code for unguarded writes to entities with restricted access. Uses the Actors & Access section of manifest.json to determine which entities each actor may write, then flags write operations in code that lack auth/role checks. Pass project_root to auto-discover manifest.json and scan all code files.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Project directory containing manifest.json and code files' },
            manifest_path: { type: 'string', description: 'Explicit path to manifest.json' },
            code_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicit list of code files (overrides project_root discovery)',
            },
            output_path: { type: 'string', description: 'Output path for the security report (default: <project_root>/security-audit.md)' },
          },
        },
      },
      {
        name: 'generate-tests',
        description:
          'Generate adversarial test cases from manifest.json — field validation, rule violations, invalid state transitions, and missing env vars. Pass project_root to auto-discover manifest.json. Writes a markdown test report.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Project directory containing manifest.json' },
            manifest_path: { type: 'string', description: 'Explicit path to manifest.json' },
            output_path: { type: 'string', description: 'Output path for the test report (default: <project_root>/adversarial-tests.md)' },
          },
        },
      },
      {
        name: 'generate-spec',
        description:
          'Analyze a project codebase and generate a requirements.md spec using Claude. Pass project_root and optionally a plain-English description of what the feature does. Writes requirements.md to the project root.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: {
              type: 'string',
              description: 'Absolute path to the project directory',
            },
            description: {
              type: 'string',
              description: 'Plain-English description of what the feature does',
            },
            feature_name: {
              type: 'string',
              description: 'Human-readable name for the feature',
            },
            owner: {
              type: 'string',
              description: 'Owner name or handle',
            },
            output_path: {
              type: 'string',
              description: 'Where to write requirements.md. Defaults to <project_root>/requirements.md',
            },
          },
          required: ['project_root'],
        },
      },
      {
        name: 'spec-drift',
        description:
          'Compare a base manifest (production) against a head manifest (PR branch) and check what the code still needs to implement. Returns a refactor checklist.',
        inputSchema: {
          type: 'object',
          properties: {
            base_manifest_path: { type: 'string' },
            head_manifest_path: { type: 'string' },
            code_paths: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['base_manifest_path', 'head_manifest_path', 'code_paths'],
        },
      },
    ],
  };
});

// Call tools
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── start-interview ───────────────────────────────────────
    if (name === 'start-interview') {
      const input = StartInterviewInput.parse(args);

      // If requirements.md already exists, compile it and skip the interview
      const existingReqPath = path.join(input.project_root, 'requirements.md');
      if (fs.existsSync(existingReqPath)) {
        const requirementsContent = fs.readFileSync(existingReqPath, 'utf-8');
        const manifest = parse(requirementsContent);
        const manifestPath = path.join(input.project_root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        return {
          content: [{ type: 'text', text: `✓ Found existing requirements.md — compiled to manifest.json. Enforcement is active.\n\nWould you like to:\n1. Start building (enforcement is already on)\n2. Update the spec (describe what's changed and I'll revise it)` }],
        };
      }

      const prompt = buildInterviewPrompt(input.context);
      const text = `${prompt}\n\n---\n_Project root: ${input.project_root}_\n_When all questions are answered, call finish-interview with the answers._`;
      return { content: [{ type: 'text', text }] };
    }

    // ── finish-interview ───────────────────────────────────────
    if (name === 'finish-interview') {
      const input = FinishInterviewInput.parse(args);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set');

      const transcript: InterviewTranscript = {
        what: input.what,
        users: input.users,
        main_thing: input.main_thing,
        fields: input.fields,
        states: input.states,
        actions: input.actions,
        rules: input.rules,
        external: input.external,
        env_vars: input.env_vars,
      };

      const outputPath = input.output_path ?? path.join(input.project_root, 'requirements.md');
      const result = await buildSpecFromTranscript(transcript, outputPath, apiKey, input.feature_name, input.owner);

      if (!result.manifestPath) {
        // Failed to parse after all retries — don't write a broken file
        const errorDetail = result.warnings.join('\n');
        throw new Error(`Could not generate a valid spec after ${result.parseAttempts} attempts.\n\n${errorDetail}`);
      }

      const statusLine = result.warnings.length > 0
        ? `⚠ ${result.warnings.join(' | ')}`
        : `✓ Spec parsed cleanly on attempt ${result.parseAttempts}`;

      const text = `${result.spec}\n\n---\n${statusLine}\n✓ requirements.md written to: ${result.outputPath}\n✓ manifest.json written — enforcement is now active.`;
      return { content: [{ type: 'text', text }] };
    }

    // ── compile-spec ──────────────────────────────────────────
    if (name === 'compile-spec') {
      const input = CompileSpecInput.parse(args);
      const requirementsPath = input.requirements_path
        ?? (input.project_root ? path.join(input.project_root, 'requirements.md') : null);
      if (!requirementsPath) throw new Error('Provide project_root or requirements_path');

      const requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
      const manifest = parse(requirementsContent);

      const dir = path.dirname(requirementsPath);
      const manifestPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const summaryLine = `✓ manifest.json written to ${dir}`;
      const text = `${JSON.stringify(manifest, null, 2)}\n\n${summaryLine}`;

      return {
        content: [{ type: 'text', text }],
      };
    }

    // ── check-integrity ───────────────────────────────────────
    if (name === 'check-integrity') {
      const input = CheckIntegrityInput.parse(args);
      const requirements_path = input.requirements_path
        ?? (input.project_root ? path.join(input.project_root, 'requirements.md') : null);
      if (!requirements_path) throw new Error('Provide project_root or requirements_path');

      const requirementsContent = fs.readFileSync(requirements_path, 'utf-8');
      const freshManifest = parse(requirementsContent);

      const dir = path.dirname(requirements_path);
      const manifestPath = path.join(dir, 'manifest.json');
      const existingManifestRaw = fs.readFileSync(manifestPath, 'utf-8');
      const existingManifest: Record<string, unknown> = JSON.parse(existingManifestRaw);

      if (deepEqual(freshManifest, existingManifest)) {
        return {
          content: [{ type: 'text', text: '✓ manifest.json is in sync' }],
        };
      }

      const diffSummary = topLevelDiffSummary(
        freshManifest as unknown as Record<string, unknown>,
        existingManifest
      );
      const text =
        `✗ manifest.json is stale or tampered. Run compile-spec to regenerate.\n${diffSummary}`;

      return {
        content: [{ type: 'text', text }],
      };
    }

    // ── contract-diff ─────────────────────────────────────────
    if (name === 'contract-diff') {
      const input = ContractDiffInput.parse(args);

      const manifestPath = input.manifest_path
        ?? (input.project_root ? path.join(input.project_root, 'manifest.json') : null);
      if (!manifestPath) throw new Error('Provide project_root or manifest_path');

      const resolvedCodePaths: string[] = input.code_paths
        ?? (input.project_root ? walkCodeFiles(input.project_root) : []);

      const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest: Manifest = JSON.parse(manifestRaw);

      const files: CodeFile[] = resolvedCodePaths.map((p) => ({
        path: p,
        content: fs.readFileSync(p, 'utf-8'),
      }));

      const result = contractDiff(manifest, files);

      let summary: string;
      if (result.violations.length === 0) {
        summary = '✓ All rules passed.';
      } else {
        summary = `Found ${result.violations.length} violation(s). ${result.passed.length} rule(s) passed.`;
      }

      const text = `${summary}\n\n${JSON.stringify(result, null, 2)}`;

      return {
        content: [{ type: 'text', text }],
      };
    }

    // ── generate-spec ─────────────────────────────────────────
    if (name === 'generate-spec') {
      const input = GenerateSpecInput.parse(args);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set');

      // Walk code files
      const codeFiles = walkCodeFiles(input.project_root).map(p => ({
        path: p,
        content: fs.readFileSync(p, 'utf-8'),
      }));

      if (codeFiles.length === 0) {
        throw new Error(`No .py/.ts/.js files found in ${input.project_root}`);
      }

      // Analyze
      const analysis = analyzeCode(codeFiles);

      // Generate
      const result = await generateSpec({
        analysis,
        description: input.description,
        featureName: input.feature_name,
        owner: input.owner,
        apiKey,
      });

      // Write
      const outputPath = input.output_path ?? path.join(input.project_root, 'requirements.md');
      fs.writeFileSync(outputPath, result.spec, 'utf-8');

      const statusLine = result.warnings.length > 0
        ? `⚠ ${result.warnings.join(' | ')}`
        : `✓ Parsed cleanly on attempt ${result.parseAttempts}`;

      const text = `${result.spec}\n\n---\n${statusLine}\nWritten to: ${outputPath}`;
      return { content: [{ type: 'text', text }] };
    }

    // ── scale-monitor ─────────────────────────────────────────
    if (name === 'scale-monitor') {
      const input = ScaleMonitorInput.parse(args);

      const manifestPath = input.manifest_path
        ?? (input.project_root ? path.join(input.project_root, 'manifest.json') : null);
      if (!manifestPath) throw new Error('Provide project_root or manifest_path');

      // Auto-discover SQLite DB in project_root
      let dbPath = input.db_path;
      if (!dbPath && input.project_root) {
        const candidates = fs.readdirSync(input.project_root)
          .filter(f => /\.(db|sqlite|sqlite3)$/.test(f))
          .map(f => path.join(input.project_root!, f));
        if (candidates.length === 0) throw new Error(`No .db/.sqlite file found in ${input.project_root}`);
        if (candidates.length > 1) throw new Error(`Multiple DB files found — specify db_path: ${candidates.join(', ')}`);
        dbPath = candidates[0];
      }
      if (!dbPath) throw new Error('Provide project_root or db_path');

      const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const result = runScaleMonitor(manifest, dbPath);
      const report = renderScaleReport(result);

      const outputPath = input.output_path
        ?? (input.project_root ? path.join(input.project_root, 'scale-report.md') : null);
      if (outputPath) fs.writeFileSync(outputPath, report, 'utf-8');

      const writtenLine = outputPath ? `\nWritten to: ${outputPath}` : '';
      return { content: [{ type: 'text', text: `${result.summary}${writtenLine}\n\n${report}` }] };
    }

    // ── security-audit ────────────────────────────────────────
    if (name === 'security-audit') {
      const input = SecurityAuditInput.parse(args);

      const manifestPath = input.manifest_path
        ?? (input.project_root ? path.join(input.project_root, 'manifest.json') : null);
      if (!manifestPath) throw new Error('Provide project_root or manifest_path');

      const resolvedCodePaths: string[] = input.code_paths
        ?? (input.project_root ? walkCodeFiles(input.project_root) : []);

      const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const files: CodeFile[] = resolvedCodePaths.map(p => ({
        path: p,
        content: fs.readFileSync(p, 'utf-8'),
      }));

      const result = securityAudit(manifest, files);
      const report = renderSecurityReport(result);

      const outputPath = input.output_path
        ?? (input.project_root ? path.join(input.project_root, 'security-audit.md') : null);
      if (outputPath) {
        fs.writeFileSync(outputPath, report, 'utf-8');
      }

      const writtenLine = outputPath ? `\nWritten to: ${outputPath}` : '';
      const text = `${result.summary}${writtenLine}\n\n${report}`;
      return { content: [{ type: 'text', text }] };
    }

    // ── generate-tests ────────────────────────────────────────
    if (name === 'generate-tests') {
      const input = GenerateTestsInput.parse(args);

      const manifestPath = input.manifest_path
        ?? (input.project_root ? path.join(input.project_root, 'manifest.json') : null);
      if (!manifestPath) throw new Error('Provide project_root or manifest_path');

      const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest: Manifest = JSON.parse(manifestRaw);

      const suite = generateTests(manifest);
      const markdown = renderMarkdown(suite);

      const outputPath = input.output_path
        ?? (input.project_root ? path.join(input.project_root, 'adversarial-tests.md') : null);
      if (outputPath) {
        fs.writeFileSync(outputPath, markdown, 'utf-8');
      }

      const total = suite.tests.length;
      const bySeverity = suite.tests.reduce<Record<string, number>>((acc, t) => {
        acc[t.severity] = (acc[t.severity] ?? 0) + 1;
        return acc;
      }, {});
      const severitySummary = Object.entries(bySeverity)
        .map(([s, n]) => `${n} ${s}`)
        .join(', ');

      const writtenLine = outputPath ? `\nWritten to: ${outputPath}` : '';
      const text = `Generated ${total} adversarial tests (${severitySummary}).${writtenLine}\n\n${markdown}`;

      return { content: [{ type: 'text', text }] };
    }

    // ── spec-drift ────────────────────────────────────────────
    if (name === 'spec-drift') {
      const { base_manifest_path, head_manifest_path, code_paths } = SpecDriftInput.parse(args);

      const baseManifest: Manifest = JSON.parse(fs.readFileSync(base_manifest_path, 'utf-8'));
      const headManifest: Manifest = JSON.parse(fs.readFileSync(head_manifest_path, 'utf-8'));

      const files: CodeFile[] = code_paths.map((p) => ({
        path: p,
        content: fs.readFileSync(p, 'utf-8'),
      }));

      const result = specDrift(baseManifest, headManifest, files);

      let summary: string;
      if (result.progress.pending === 0) {
        summary = '✓ No drift. Code matches spec.';
      } else {
        summary = `Spec drift: v${result.baseVersion} → v${result.headVersion}. ${result.progress.pending} item(s) pending, ${result.progress.completed} implemented.`;
      }

      const text = `${summary}\n\n${JSON.stringify(result, null, 2)}`;

      return {
        content: [{ type: 'text', text }],
      };
    }

    return {
      content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }],
      isError: true,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Start server ────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
