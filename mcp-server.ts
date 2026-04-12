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
import { findGuardedScope, getRuleScope } from './src/diff-engine/detectors';
import { CodeFile } from './src/diff-engine/types';
import { Manifest } from './src/types';
import { analyzeCode } from './src/interview/code-analyzer';
import { generateSpec } from './src/interview/spec-generator';
import { generateTests, renderMarkdown } from './src/adversarial/test-generator';
import { evaluateTests, renderFailureBlock } from './src/adversarial/test-evaluator';
import { collectCodeFiles } from './src/inspect/runner';
import { securityAudit, renderSecurityReport } from './src/security/access-auditor';
import { coherenceScan } from './src/coherence/index';
import { runScaleMonitor, renderScaleReport } from './src/scale/monitor';
import * as crypto from 'crypto';
import { buildInterviewPrompt, buildSpecFromTranscript, InterviewTranscript } from './src/interview/interviewer';
import { generateProjectReadme, buildReadmeFromManifest } from './src/interview/readme-generator';
import { scanProject, formatScannedContext } from './src/interview/project-scanner';
import { checkContradictionsWithLLM, renderContradictionReport } from './src/inspect/contradiction-checker';
import { injectScopes } from './src/enrich';

function writeReadmeHash(projectRoot: string, requirementsContent: string): void {
  const dir = path.join(projectRoot, '.uptocode');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha256').update(requirementsContent).digest('hex');
  fs.writeFileSync(path.join(dir, 'readme_spec_hash'), hash, 'utf-8');
}

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
  project_root: z.string().optional().describe('Project directory — manifest.json is auto-discovered here'),
  manifest_path: z.string().optional().describe('Explicit path to manifest.json'),
  db_path: z.string().optional().describe('Explicit path to SQLite database file'),
  database_url: z.string().optional().describe('Postgres connection string (postgres://...). Falls back to DATABASE_URL env var in the project'),
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

const SetupGithubInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory'),
  repo_name: z.string().describe('Name for the GitHub repository (e.g. "my-app")'),
  private: z.boolean().optional().describe('Make the repository private. Defaults to false (public).'),
});

const GenerateReadmeInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory containing requirements.md'),
});

const SessionReportInput = z.object({
  project_root: z.string(),
});

const ApplyFixInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory'),
  file_path: z.string().describe('Absolute or project-relative path to the file containing the violation'),
  rule_id: z.string().describe('The rule ID to fix, e.g. RULE_SEC_01'),
  line: z.number().optional().describe('Line number of the violation (from contract-diff output)'),
});

const GenerateSpecInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory to analyze'),
  description: z.string().optional().describe('Natural language description of what the feature does'),
  feature_name: z.string().optional().describe('Human-readable feature name (e.g. "Document Processing")'),
  owner: z.string().optional().describe('Owner name or handle'),
  output_path: z.string().optional().describe('Where to write requirements.md. Defaults to <project_root>/requirements.md'),
});

const RegenerateInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory'),
  description: z.string().optional().describe('Optional plain-English description passed to generate-spec'),
  feature_name: z.string().optional().describe('Optional feature name passed to generate-spec'),
  owner: z.string().optional().describe('Optional owner handle'),
});

const CoherenceScanInput = z.object({
  project_root: z.string().describe('Absolute path to the project directory containing manifest.json and code files'),
  manifest_path: z.string().optional().describe('Explicit path to manifest.json. Overrides project_root discovery.'),
  code_paths: z.array(z.string()).optional().describe('Explicit list of absolute paths to code files. Overrides project_root file discovery.'),
});

// ── Helper: apply-fix hint builder ──────────────────────────────

function buildApplyFixHint(
  rule: { type: string; condition: string; title: string },
  enforcement: { severity: string; responses: Array<{ action: string }> }
): string {
  const condition = rule.condition;
  const responses = enforcement.responses.map(r => r.action).join(', ');

  if (rule.type === 'Security' && condition.includes('Session.created_at')) {
    const m = condition.match(/INTERVAL\((\d+),\s*(\w+)\)/);
    if (m) return `Add middleware: reject if Session.created_at < NOW() - INTERVAL(${m[1]}, ${m[2]}). On violation: ${responses}.`;
  }
  if (rule.type === 'Security' && condition.includes('actor.type')) {
    const m = condition.match(/actor\.type\s*==\s*['"](\w+)['"]/);
    if (m) return `Restrict this route to actor type '${m[1]}' only. On violation: ${responses}.`;
  }
  if (rule.type === 'Business') {
    const m = condition.match(/entity\.(\w+)/);
    if (m) return `Add a guard: check \`${m[1]}\` before the operation. On violation: ${responses}.`;
  }
  if (rule.type === 'Validation') {
    const m = condition.match(/entity\.(\w+)/);
    if (m) return `Validate \`${m[1]}\` is not empty/null before processing. On violation: ${responses}.`;
  }
  return `Implement: \`${condition}\`. On violation: ${responses}.`;
}

// ── Helper: git commit nudge ─────────────────────────────────────

function gitNudge(projectRoot: string): string {
  try {
    const { execSync } = require('child_process');
    // Bail if not a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectRoot, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
    if (!status) return ''; // nothing uncommitted
    const fileCount = status.split('\n').filter(Boolean).length;
    return `\n\n→ ${fileCount} uncommitted file(s) detected. Consider committing your work:\n  git add -A && git commit -m "feat: <describe what you built>" && git push`;
  } catch {
    return '';
  }
}

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
        name: 'generate-readme',
        description:
          'Generates a plain-English README.md for the project from its requirements.md spec. Call this when the user asks for a README, or when setting up a project that does not have one.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Absolute path to the project directory containing requirements.md' },
          },
          required: ['project_root'],
        },
      },
      {
        name: 'setup-github',
        description:
          'Creates a GitHub repository for the project, pushes the code, and installs the UpToCode inspection workflow. After this, every push automatically triggers a Building Inspection Report. Call this when the user asks to set up GitHub or wants automatic inspection reports.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Absolute path to the project directory' },
            repo_name: { type: 'string', description: 'Name for the GitHub repository' },
            private: { type: 'boolean', description: 'Make the repository private (default: false)' },
          },
          required: ['project_root', 'repo_name'],
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
          'Query a live database (SQLite or Postgres) and evaluate health checks derived from the manifest: entity state distribution, computed property values, FK integrity, and record volumes. Pass project_root to auto-discover manifest.json. For Postgres projects, reads DATABASE_URL from the project .env file automatically. Flags backlogs, failure rates, and orphaned records.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Project directory — manifest.json is auto-discovered here' },
            manifest_path: { type: 'string', description: 'Explicit path to manifest.json' },
            db_path: { type: 'string', description: 'Explicit path to SQLite database file' },
            database_url: { type: 'string', description: 'Postgres connection string (postgres://...). Falls back to DATABASE_URL in project .env' },
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
      {
        name: 'regenerate',
        description:
          'Full project regeneration in one shot: generate-spec → compile-spec → contract-diff. Rewrites requirements.md from the codebase, compiles manifest.json and README.md, then checks for rule violations and orphaned routes. Returns a combined report.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Absolute path to the project directory' },
            description: { type: 'string', description: 'Optional plain-English description of what the feature does' },
            feature_name: { type: 'string', description: 'Optional human-readable feature name' },
            owner: { type: 'string', description: 'Optional owner name or handle' },
          },
          required: ['project_root'],
        },
      },
      {
        name: 'session-report',
        description:
          'Show a cumulative report of everything UpToCode has caught and fixed in this project — top violated rules, most-flagged files, resolution rate, and a timeline. Pass project_root to auto-discover the session log.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Absolute path to the project directory' },
          },
          required: ['project_root'],
        },
      },
      {
        name: 'apply-fix',
        description:
          'Prepare context for fixing a specific rule violation. Reads the violating file, the rule from manifest.json, and similar guard patterns already in the codebase. Returns the file content with line numbers, the rule condition, the fix hint, and style examples — so you can apply the exact fix needed.',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Absolute path to the project directory' },
            file_path: { type: 'string', description: 'Path to the file containing the violation (absolute or relative to project_root)' },
            rule_id: { type: 'string', description: 'The rule ID to fix, e.g. RULE_SEC_01' },
            line: { type: 'number', description: 'Line number of the violation (from contract-diff output)' },
          },
          required: ['project_root', 'file_path', 'rule_id'],
        },
      },
      {
        name: 'coherence-scan',
        description:
          'Scan the codebase for structural quality issues that arise specifically from AI-generated code across multiple sessions. Detects six categories: dead exports and dead files, silent catch blocks that void validation contracts, env vars read at module scope, duplicate string literals and logic blocks, TypeScript interface/runtime validator mismatches, and API envelope inconsistencies across sibling routes. Returns issues grouped by severity (HIGH/MEDIUM actionable, LOW advisory).',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: { type: 'string', description: 'Absolute path to the project directory containing manifest.json and code files' },
            manifest_path: { type: 'string', description: 'Explicit path to manifest.json (overrides project_root discovery)' },
            code_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicit list of code files to scan (overrides project_root file discovery)',
            },
          },
          required: ['project_root'],
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

      // Check if project has a GitHub remote — if not, suggest setup
      let githubTip = '';
      try {
        const { execSync } = await import('child_process');
        execSync('git remote get-url origin', { cwd: input.project_root, stdio: 'pipe' });
      } catch {
        githubTip = '\n\n→ Want automatic inspection reports on every push?\n  Say "Help me set up GitHub for this project" and I\'ll take care of it.';
      }

      const text = `${result.spec}\n\n---\n${statusLine}\n✓ requirements.md written to: ${result.outputPath}\n✓ manifest.json written — enforcement is now active.${githubTip}`;
      return { content: [{ type: 'text', text }] };
    }

    // ── compile-spec ──────────────────────────────────────────
    if (name === 'compile-spec') {
      const input = CompileSpecInput.parse(args);
      const requirementsPath = input.requirements_path
        ?? (input.project_root ? path.join(input.project_root, 'requirements.md') : null);
      if (!requirementsPath) throw new Error('Provide project_root or requirements_path');

      let requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');

      // Migrate any scope data Claude added manually to manifest.json into requirements.md
      // so it survives this and all future recompilations.
      const dir = path.dirname(requirementsPath);
      const existingManifestPath = path.join(dir, 'manifest.json');
      if (fs.existsSync(existingManifestPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf-8'));
          if (existing.rules) {
            const migrated = injectScopes(requirementsContent, existing.rules);
            if (migrated !== requirementsContent) requirementsContent = migrated;
          }
        } catch { /* non-fatal — proceed without migration */ }
      }

      const manifest = parse(requirementsContent);

      // ── Contradiction check (runs before writing anything) ────
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      const contradictionReport = await checkContradictionsWithLLM(manifest, apiKey);
      if (contradictionReport.hasBlockers) {
        return {
          content: [{ type: 'text', text: renderContradictionReport(contradictionReport) }],
        };
      }

      const manifestPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      // Always regenerate README.md from the compiled manifest
      const readmePath = path.join(dir, 'README.md');
      const scannedCtx = formatScannedContext(scanProject(dir));
      const readme = await buildReadmeFromManifest(manifest, apiKey || undefined, scannedCtx || undefined);
      fs.writeFileSync(readmePath, readme, 'utf-8');

      const warningText = contradictionReport.contradictions.length > 0
        ? '\n\n' + renderContradictionReport(contradictionReport)
        : '';
      const summaryLine = `✓ manifest.json and README.md written to ${dir}`;
      const text = `${JSON.stringify(manifest, null, 2)}\n\n${summaryLine}${warningText}`;

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

      let result = contractDiff(manifest, files);

      // Auto-scope: for unscoped rules with violations, infer scope from handlers
      // that already have the guard implemented, update requirements.md + recompile.
      let autoFixReport = '';
      if (result.violations.length > 0 && input.project_root) {
        const requirementsPath = path.join(input.project_root, 'requirements.md');
        if (fs.existsSync(requirementsPath)) {
          let requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
          const fixes: string[] = [];

          for (const violation of result.violations) {
            const rule = manifest.rules[violation.ruleId];
            if (!rule) continue;
            if (getRuleScope(rule).length > 0) continue; // already scoped

            const suggestedScope = findGuardedScope(rule, files);
            if (suggestedScope.length === 0) continue;

            requirementsContent = injectScopes(requirementsContent, {
              [violation.ruleId]: { scope: suggestedScope },
            });
            fixes.push(`${violation.ruleId} → Scope: ${suggestedScope.join(', ')}`);
          }

          if (fixes.length > 0) {
            fs.writeFileSync(requirementsPath, requirementsContent, 'utf-8');
            const newManifest = parse(requirementsContent);
            fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2), 'utf-8');
            result = contractDiff(newManifest, files);
            autoFixReport = `\n\n🔧 Auto-scoped ${fixes.length} rule(s):\n${fixes.map(f => `  • ${f}`).join('\n')}\nrequirements.md and manifest.json updated automatically.`;
          }
        }
      }

      let summary: string;
      if (result.violations.length === 0 && result.orphaned.length === 0) {
        const nudge = input.project_root ? gitNudge(input.project_root) : '';
        summary = `✓ All rules passed.${nudge}`;
      } else {
        const parts: string[] = [];
        if (result.violations.length > 0) parts.push(`${result.violations.length} violation(s)`);
        if (result.orphaned.length > 0) parts.push(`${result.orphaned.length} orphaned route(s) — endpoints serving entities removed from the spec`);
        summary = `Found ${parts.join(' and ')}. ${result.passed.length} rule(s) passed.`;
      }

      const text = `${summary}${autoFixReport}\n\n${JSON.stringify(result, null, 2)}`;

      return {
        content: [{ type: 'text', text }],
      };
    }

    // ── regenerate ────────────────────────────────────────────
    if (name === 'regenerate') {
      const input = RegenerateInput.parse(args);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set');

      const sections: string[] = [];

      // 1. generate-spec
      sections.push('## Step 1: generate-spec');
      const codeFiles = walkCodeFiles(input.project_root).map(p => ({
        path: p,
        content: fs.readFileSync(p, 'utf-8'),
      }));
      if (codeFiles.length === 0) throw new Error(`No .py/.ts/.js files found in ${input.project_root}`);
      const analysis = analyzeCode(codeFiles);
      const specResult = await generateSpec({ analysis, description: input.description, featureName: input.feature_name, owner: input.owner, apiKey });
      const requirementsPath = path.join(input.project_root, 'requirements.md');
      fs.writeFileSync(requirementsPath, specResult.spec, 'utf-8');
      sections.push(`✓ requirements.md written (${specResult.spec.split('\n').length} lines)`);

      // 2. compile-spec
      sections.push('\n## Step 2: compile-spec');
      let requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
      const existingManifestPath = path.join(input.project_root, 'manifest.json');
      if (fs.existsSync(existingManifestPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf-8'));
          if (existing.rules) {
            const migrated = injectScopes(requirementsContent, existing.rules);
            if (migrated !== requirementsContent) requirementsContent = migrated;
          }
        } catch { /* non-fatal */ }
      }
      const manifest = parse(requirementsContent);
      fs.writeFileSync(existingManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      const readmePath = path.join(input.project_root, 'README.md');
      const scannedCtx2 = formatScannedContext(scanProject(input.project_root));
      fs.writeFileSync(readmePath, await buildReadmeFromManifest(manifest, apiKey || undefined, scannedCtx2 || undefined), 'utf-8');
      const entityCount = Object.keys(manifest.dataModel).length;
      const ruleCount = Object.keys(manifest.rules).length;
      sections.push(`✓ manifest.json written (${entityCount} entities, ${ruleCount} rules)`);
      sections.push(`✓ README.md written`);

      // 3. contract-diff
      sections.push('\n## Step 3: contract-diff');
      const files: CodeFile[] = walkCodeFiles(input.project_root).map(p => ({
        path: p,
        content: fs.readFileSync(p, 'utf-8'),
      }));
      let diffResult = contractDiff(manifest, files);

      // Auto-scope
      let autoFixReport = '';
      if (diffResult.violations.length > 0) {
        let reqContent = fs.readFileSync(requirementsPath, 'utf-8');
        const fixes: string[] = [];
        for (const violation of diffResult.violations) {
          const rule = manifest.rules[violation.ruleId];
          if (!rule || getRuleScope(rule).length > 0) continue;
          const suggestedScope = findGuardedScope(rule, files);
          if (suggestedScope.length === 0) continue;
          reqContent = injectScopes(reqContent, { [violation.ruleId]: { scope: suggestedScope } });
          fixes.push(`${violation.ruleId} → Scope: ${suggestedScope.join(', ')}`);
        }
        if (fixes.length > 0) {
          fs.writeFileSync(requirementsPath, reqContent, 'utf-8');
          const newManifest = parse(reqContent);
          fs.writeFileSync(existingManifestPath, JSON.stringify(newManifest, null, 2), 'utf-8');
          diffResult = contractDiff(newManifest, files);
          autoFixReport = `\n🔧 Auto-scoped: ${fixes.join(', ')}`;
        }
      }

      const vCount = diffResult.violations.length;
      const oCount = diffResult.orphaned.length;
      const pCount = diffResult.passed.length;
      if (vCount === 0 && oCount === 0) {
        sections.push(`✓ All ${pCount} rules passed. No orphaned routes.`);
      } else {
        if (vCount > 0) sections.push(`⚠ ${vCount} violation(s) found`);
        if (oCount > 0) sections.push(`⚠ ${oCount} orphaned route(s) found`);
        sections.push(`✓ ${pCount} rules passed`);
      }
      if (autoFixReport) sections.push(autoFixReport);

      const text = [
        `# Regenerate: ${path.basename(input.project_root)}`,
        '',
        sections.join('\n'),
        '',
        '---',
        JSON.stringify({ violations: diffResult.violations, orphaned: diffResult.orphaned, passed: diffResult.passed }, null, 2),
      ].join('\n');

      return { content: [{ type: 'text', text }] };
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

      // Resolve database connection: explicit postgres URL > explicit db_path >
      // DATABASE_URL from project .env > auto-discover SQLite file
      let dbConnection = input.database_url ?? input.db_path;

      if (!dbConnection && input.project_root) {
        // Try reading DATABASE_URL from project .env
        const envFile = path.join(input.project_root, '.env');
        if (fs.existsSync(envFile)) {
          const envContent = fs.readFileSync(envFile, 'utf-8');
          const match = envContent.match(/^DATABASE_URL\s*=\s*["']?([^\s"'\n]+)["']?/m);
          if (match) dbConnection = match[1];
        }
      }

      if (!dbConnection && input.project_root) {
        // Fall back to auto-discovering a SQLite file
        const candidates = fs.readdirSync(input.project_root)
          .filter(f => /\.(db|sqlite|sqlite3)$/.test(f))
          .map(f => path.join(input.project_root!, f));
        if (candidates.length === 1) dbConnection = candidates[0];
        else if (candidates.length > 1) throw new Error(`Multiple DB files found — specify db_path: ${candidates.join(', ')}`);
      }

      if (!dbConnection) throw new Error('No database found. Provide database_url, db_path, or a project_root with a .env containing DATABASE_URL');

      const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const result = await runScaleMonitor(manifest, dbConnection);
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

      // Evaluate the tests against the codebase when project_root is available.
      // Failures are appended so Claude automatically starts fixing them.
      let failureBlock = '';
      if (input.project_root) {
        const codeFiles = collectCodeFiles(input.project_root);
        const evalReport = evaluateTests(suite, codeFiles);
        failureBlock = renderFailureBlock(evalReport);
      }

      const text = `Generated ${total} adversarial tests (${severitySummary}).${writtenLine}\n\n${markdown}${failureBlock}`;

      return { content: [{ type: 'text', text }] };
    }

    // ── generate-readme ───────────────────────────────────────
    if (name === 'generate-readme') {
      const input = GenerateReadmeInput.parse(args);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set');

      const requirementsPath = path.join(input.project_root, 'requirements.md');
      if (!fs.existsSync(requirementsPath)) {
        throw new Error('No requirements.md found. Run "Interview me to build my spec" first.');
      }

      const requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
      const projectName = path.basename(input.project_root);
      const codeCtx = formatScannedContext(scanProject(input.project_root));
      const readme = await generateProjectReadme(requirementsContent, projectName, apiKey, codeCtx || undefined);

      const readmePath = path.join(input.project_root, 'README.md');
      fs.writeFileSync(readmePath, readme, 'utf-8');
      writeReadmeHash(input.project_root, requirementsContent);

      return {
        content: [{ type: 'text', text: `✓ README.md written to ${readmePath}` }],
      };
    }

    // ── setup-github ──────────────────────────────────────────
    if (name === 'setup-github') {
      const input = SetupGithubInput.parse(args);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const { execSync } = await import('child_process');
      const visibility = input.private ? '--private' : '--public';
      const workflowDir = path.join(input.project_root, '.github', 'workflows');
      const workflowDest = path.join(workflowDir, 'uptocode.yml');
      const workflowSrc = path.join(__dirname, 'ci', 'example-workflow.yml');

      // Generate README if one doesn't exist
      const readmePath = path.join(input.project_root, 'README.md');
      const requirementsPath = path.join(input.project_root, 'requirements.md');
      if (!fs.existsSync(readmePath) && fs.existsSync(requirementsPath) && apiKey) {
        const requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
        const projectName = path.basename(input.project_root);
        const readme = await generateProjectReadme(requirementsContent, projectName, apiKey);
        fs.writeFileSync(readmePath, readme, 'utf-8');
        writeReadmeHash(input.project_root, requirementsContent);
      }

      // Ensure git is initialised
      if (!fs.existsSync(path.join(input.project_root, '.git'))) {
        execSync('git init && git add -A && git commit -m "Initial commit"', {
          cwd: input.project_root, shell: '/bin/bash', stdio: 'pipe',
        });
      }

      // Create repo on GitHub and push
      execSync(
        `gh repo create ${input.repo_name} ${visibility} --source="${input.project_root}" --remote=origin --push`,
        { shell: '/bin/bash', stdio: 'pipe' },
      );

      // Add UpToCode workflow
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.copyFileSync(workflowSrc, workflowDest);
      execSync('git add .github/ && git commit -m "Add UpToCode inspection workflow" && git push', {
        cwd: input.project_root, shell: '/bin/bash', stdio: 'pipe',
      });

      const repoUrl = execSync('gh repo view --json url -q .url', { shell: '/bin/bash' }).toString().trim();
      const actionsUrl = `${repoUrl}/actions`;
      const readmeCreated = !fs.existsSync(readmePath) ? '' : '\n✓ README.md generated from your spec';

      // Enable branch protection — require Building Inspection to pass before merge
      let branchProtectionNote = '';
      try {
        const nameWithOwner = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
          shell: '/bin/bash',
        }).toString().trim();
        const defaultBranch = execSync(
          'git remote show origin | grep "HEAD branch" | awk \'{print $NF}\'',
          { cwd: input.project_root, shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] },
        ).toString().trim() || 'main';
        const protectionBody = JSON.stringify({
          required_status_checks: { strict: false, contexts: ['Building Inspection'] },
          enforce_admins: false,
          required_pull_request_reviews: null,
          restrictions: null,
        });
        execSync(
          `gh api repos/${nameWithOwner}/branches/${defaultBranch}/protection --method PUT --input -`,
          { input: protectionBody, shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        branchProtectionNote = `✓ Branch protection enabled — PRs auto-merge only when inspection passes`;
      } catch {
        branchProtectionNote = `⚠ Branch protection requires GitHub Pro for private repos — make the repo public or upgrade to enable auto-merge gating`;
      }

      return {
        content: [{
          type: 'text',
          text: [
            `✓ GitHub repository created: ${repoUrl}`,
            `✓ Code pushed to GitHub`,
            readmeCreated,
            `✓ UpToCode inspection workflow added`,
            branchProtectionNote,
            ``,
            `Every push from now on will trigger a Building Inspection Report.`,
            `View results at: ${actionsUrl}`,
            ``,
            `The UpToCode Stop hook will also auto-commit and push at the end of each session.`,
          ].filter(Boolean).join('\n'),
        }],
      };
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

    // ── apply-fix ─────────────────────────────────────────────
    if (name === 'apply-fix') {
      const input = ApplyFixInput.parse(args);

      // Resolve file path
      const filePath = path.isAbsolute(input.file_path)
        ? input.file_path
        : path.join(input.project_root, input.file_path);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Load manifest to get the rule
      const manifestPath = path.join(input.project_root, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`manifest.json not found in ${input.project_root}. Run compile-spec first.`);
      }
      const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const rule = (manifest.rules as Record<string, unknown>)[input.rule_id] as {
        id: string; type: string; title: string; condition: string;
      } | undefined;

      if (!rule) {
        throw new Error(`Rule ${input.rule_id} not found in manifest.json`);
      }

      const enforcement = manifest.enforcement.find(e => e.ruleId === input.rule_id);

      // Read the violating file with line numbers
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const numbered = fileContent
        .split('\n')
        .map((l, i) => `${String(i + 1).padStart(4, ' ')} | ${l}`)
        .join('\n');

      // Find similar guard patterns in the codebase for style reference
      const allFiles = walkCodeFiles(input.project_root);
      const guardPatterns: string[] = [];
      const guardRegex = /if\s*\(!?req\.(user|session|auth)|requireAuth|isAuthenticated|checkPermission|hasRole|middleware/i;
      for (const f of allFiles) {
        if (f === filePath) continue;
        const content = fs.readFileSync(f, 'utf-8');
        const matches = content.split('\n').filter(l => guardRegex.test(l)).slice(0, 3);
        if (matches.length > 0) {
          guardPatterns.push(`// ${path.relative(input.project_root, f)}\n${matches.join('\n')}`);
        }
        if (guardPatterns.length >= 3) break;
      }

      const lineNote = input.line ? ` at line ${input.line}` : '';
      const severityNote = enforcement ? ` [${enforcement.severity}]` : '';
      const styleSection = guardPatterns.length > 0
        ? `\n\n## Existing guard patterns in this codebase (match this style)\n\`\`\`\n${guardPatterns.join('\n\n')}\n\`\`\``
        : '';

      const text = [
        `## Fix ${input.rule_id}${severityNote} — ${rule.title}`,
        ``,
        `**Rule type:** ${rule.type}`,
        `**Condition:** \`${rule.condition}\``,
        `**Fix hint:** ${enforcement ? buildApplyFixHint(rule, enforcement) : rule.condition}`,
        ``,
        `## File: ${path.relative(input.project_root, filePath)}${lineNote}`,
        `\`\`\``,
        numbered,
        `\`\`\``,
        styleSection,
        ``,
        `→ Apply the fix to satisfy \`${input.rule_id}\`. Edit the file above to add the missing guard.`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    // ── session-report ────────────────────────────────────────
    if (name === 'session-report') {
      const input = SessionReportInput.parse(args);
      const logPath = path.join(input.project_root, '.uptocode', 'session.jsonl');

      if (!fs.existsSync(logPath)) {
        return { content: [{ type: 'text', text: 'No session log found — UpToCode has not recorded any activity for this project yet.' }] };
      }

      interface LogEntry {
        ts: string;
        file: string;
        violations?: Array<{ ruleId: string; severity: string; title: string; line?: number }>;
        clean?: boolean;
      }

      const entries: LogEntry[] = fs.readFileSync(logPath, 'utf-8')
        .trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'Session log is empty.' }] };
      }

      // Load manifest for plain-English rule descriptions
      const manifestPath = path.join(input.project_root, 'manifest.json');
      let manifestRules: Record<string, { title: string; message: string; type: string }> = {};
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifestRules = m.rules ?? {};
      } catch { /* proceed without — fall back to log titles */ }

      // Aggregate
      const ruleHits: Record<string, { title: string; message: string; type: string; severity: string; count: number; filesFixed: Set<string> }> = {};
      const fileHits: Record<string, { violations: number; fixed: boolean }> = {};
      const violationFiles = new Set<string>();
      let totalCaught = 0;

      for (const entry of entries) {
        if (entry.violations && entry.violations.length > 0) {
          violationFiles.add(entry.file);
          fileHits[entry.file] = fileHits[entry.file] ?? { violations: 0, fixed: false };
          fileHits[entry.file].violations += entry.violations.length;
          totalCaught += entry.violations.length;

          for (const v of entry.violations) {
            if (!ruleHits[v.ruleId]) {
              const manifest = manifestRules[v.ruleId];
              ruleHits[v.ruleId] = {
                title:      manifest?.title    ?? v.title,
                message:    manifest?.message  ?? '',
                type:       manifest?.type     ?? '',
                severity:   v.severity,
                count:      0,
                filesFixed: new Set(),
              };
            }
            ruleHits[v.ruleId].count++;
          }
        } else if (entry.clean && violationFiles.has(entry.file)) {
          fileHits[entry.file].fixed = true;
          // Credit any rules last triggered in this file as fixed
          const lastViolation = [...entries].reverse().find(e => e.file === entry.file && e.violations);
          if (lastViolation?.violations) {
            for (const v of lastViolation.violations) {
              ruleHits[v.ruleId]?.filesFixed.add(entry.file);
            }
          }
        }
      }

      const firstTs  = new Date(entries[0].ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const lastTs   = new Date(entries[entries.length - 1].ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const flagged  = Object.keys(fileHits).length;
      const resolved = Object.values(fileHits).filter(f => f.fixed).length;
      const allFixed = resolved === flagged;

      // Plain-English severity → user impact
      function impactLabel(severity: string): string {
        switch (severity) {
          case 'CRITICAL': return 'would have broken this feature entirely for users';
          case 'HIGH':     return 'would have caused failures for most users';
          case 'MEDIUM':   return 'would have caused incorrect behavior in some cases';
          default:         return 'could have caused unexpected behavior in edge cases';
        }
      }

      // Plain-English rule type label
      function typeLabel(type: string): string {
        switch (type) {
          case 'Security':   return 'Security issue';
          case 'Business':   return 'Logic issue';
          case 'Validation': return 'Data issue';
          default:           return 'Issue';
        }
      }

      const topRules = Object.entries(ruleHits)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6);

      const topFiles = Object.entries(fileHits)
        .sort((a, b) => b[1].violations - a[1].violations)
        .slice(0, 8);

      // Headline summary
      const resolvedNote = allFixed
        ? `All ${flagged} affected file${flagged !== 1 ? 's' : ''} ${flagged === 1 ? 'has' : 'have'} been cleaned up.`
        : `${resolved} of ${flagged} affected files cleaned up — ${flagged - resolved} still open.`;

      const lines = [
        `## UpToCode Activity Report`,
        `_${firstTs} → ${lastTs}_`,
        ``,
        `UpToCode caught **${totalCaught} issue${totalCaught !== 1 ? 's' : ''}** before they reached your users. ${resolvedNote}`,
        ``,
        `### What was caught`,
        ``,
      ];

      for (const [ruleId, info] of topRules) {
        const fixedCount = info.filesFixed.size;
        const fixNote    = fixedCount > 0 ? `, ${fixedCount === info.count ? 'all' : fixedCount} fixed` : ', not yet fixed';
        const label      = info.type ? typeLabel(info.type) : 'Issue';
        const impact     = impactLabel(info.severity);

        lines.push(`**${info.title}** — caught ${info.count}×${fixNote}`);
        if (info.message) {
          lines.push(`_${info.message}_`);
        }
        lines.push(`${label}: ${impact}.`);
        lines.push(``);
      }

      lines.push(`### Files`);
      lines.push(``);
      for (const [file, info] of topFiles) {
        const status = info.fixed ? '✓ Fixed' : '○ Open';
        const count  = `${info.violations} issue${info.violations !== 1 ? 's' : ''}`;
        lines.push(`- ${status} — \`${file}\` (${count})`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── coherence-scan ────────────────────────────────────────
    if (name === 'coherence-scan') {
      const input = CoherenceScanInput.parse(args);

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

      const result = await coherenceScan(manifest, files);

      const summaryLine = result.issues.length === 0
        ? '✓ No coherence issues found.'
        : `Found ${result.issues.length} coherence issue(s) — ${result.failed} actionable (HIGH/MEDIUM), ${result.passed} advisory (LOW).`;

      let issueText = '';
      if (result.issues.length > 0) {
        const grouped: Record<string, typeof result.issues> = { HIGH: [], MEDIUM: [], LOW: [] };
        for (const issue of result.issues) grouped[issue.severity].push(issue);

        const parts: string[] = [];
        for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
          if (grouped[sev].length === 0) continue;
          parts.push(`\n### ${sev} (${grouped[sev].length})`);
          for (const issue of grouped[sev]) {
            const loc = issue.line ? `:${issue.line}` : '';
            parts.push(`\n**[${issue.id}]** ${issue.message}`);
            parts.push(`File: \`${issue.file}${loc}\``);
            parts.push(`Detail: ${issue.detail}`);
            parts.push(`Fix: ${issue.fixHint}`);
          }
        }
        issueText = parts.join('\n');
      }

      const nudge = input.project_root ? gitNudge(input.project_root) : '';
      const text = `${summaryLine}${nudge}${issueText}\n\n${JSON.stringify(result, null, 2)}`;
      return { content: [{ type: 'text', text }] };
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
