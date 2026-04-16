/**
 * Generates a plain-English README.md for the user's project from their spec.
 *
 * Reads requirements.md and calls Claude to produce a friendly, non-technical
 * README describing what the app does, who it's for, and how to get started.
 *
 * Also exports buildReadmeFromManifest — called automatically by compile-spec.
 * It always attempts LLM synthesis for "How it works" and "Key concepts",
 * letting the Anthropic SDK auto-detect the API key from the environment
 * (ANTHROPIC_API_KEY). Falls back to a deterministic render if the call fails.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Manifest } from '../types';
import { generateDiagramsSection } from './diagram-generator';

// ── LLM synthesis helpers ─────────────────────────────────────────────────────

function stripFences(text: string): string {
  return text.startsWith('```')
    ? text.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim()
    : text.trim();
}

async function synthesizeHowItWorks(
  manifest: Manifest,
  codebaseContext?: string,
): Promise<string> {
  const rules = Object.values(manifest.rules ?? {});
  if (rules.length === 0 && !codebaseContext) return '';

  const ruleList = rules.map(r => `- ${r.title}: ${r.message}`).join('\n');
  const codeSection = codebaseContext
    ? `\nCurrent codebase (routes, nav, domain logic):\n${codebaseContext}`
    : '';

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `You are writing a "How it works" section for a user-facing README.

Product: ${manifest.feature.name}
Purpose: ${manifest.feature.intent ?? ''}

Using the spec rules and codebase context below, explain what the app does automatically and what it requires to work. Write for a non-technical user who wants to understand the product, not build it.

Spec rules:
${ruleList || '(none)'}
${codeSection}

Write a "## How it works" section. Use 4–7 plain-English bullet points covering the key behaviours a user would notice. Draw on the codebase context to name real features (e.g. actual nav sections, route names, analysis types). Don't use words like "rule", "condition", "validation", "entity", or "null". Bold the key phrase per bullet, then "—" and an explanation.

Output ONLY the markdown section. No preamble.`,
    }],
  });

  const content = msg.content[0];
  if (content.type !== 'text') return '';
  return stripFences(content.text) + '\n';
}

async function synthesizeKeyConcepts(
  manifest: Manifest,
  codebaseContext?: string,
): Promise<string> {
  const entities = Object.entries(manifest.dataModel ?? {}).filter(([, e]) => e.description);
  if (entities.length === 0 && !codebaseContext) return '';

  const entityList = entities
    .map(([name, e]) => `- ${name}: ${e.description}${e.notes ? ` (${e.notes})` : ''}`)
    .join('\n');
  const codeSection = codebaseContext
    ? `\nCurrent codebase (routes, nav, domain logic):\n${codebaseContext}`
    : '';

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are writing a "Key concepts" section for a user-facing README.

Product: ${manifest.feature.name}
Purpose: ${manifest.feature.intent ?? ''}

Using the spec concepts and codebase context below, explain the important concepts and terms a user needs to understand this product. Write from the user's perspective — what they see and interact with, not the database schema.

Spec concepts:
${entityList || '(none)'}
${codeSection}

Write a "## Key concepts" section. Start with one sentence introducing what the product tracks. Then write a bullet per important concept using the actual names from the UI/codebase (e.g. if there's an "AI Assist" nav section, explain it). Format: "**Name** — plain-English explanation". Unpack any jargon or abbreviations (e.g. "SME" → "Subject Matter Expert — a person tagged as the go-to expert for a topic"). Skip internal plumbing: caches, sync trackers, version history, audit logs. Under 350 words.

Output ONLY the markdown section. No preamble.`,
    }],
  });

  const content = msg.content[0];
  if (content.type !== 'text') return '';
  return stripFences(content.text) + '\n';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a README.md from a compiled manifest. Called automatically by compile-spec.
 *
 * Always attempts LLM synthesis for "How it works" and "Key concepts" using the
 * Anthropic SDK's auto-detected API key (ANTHROPIC_API_KEY env var). If the call
 * fails for any reason, both sections fall back to a deterministic render.
 *
 * Pass codebaseContext (from scanProject / formatScannedContext) so Claude can
 * reference real nav items, route names, and domain vocabulary from the actual
 * codebase — not just the spec, which rarely captures UI structure or terminology.
 */
export async function buildReadmeFromManifest(
  manifest: Manifest,
  codebaseContext?: string,
): Promise<string> {
  const lines: string[] = [];
  const { name, intent } = manifest.feature;

  // ── Title & intent ───────────────────────────────────────────
  lines.push(`# ${name}`, '');
  if (intent) lines.push(intent, '');

  // ── Integrations ─────────────────────────────────────────────
  const providers = Object.entries(manifest.externalProviders ?? {});
  if (providers.length > 0) {
    lines.push('## Integrations', '');
    for (const [pname, p] of providers) {
      lines.push(`- **${pname}** — ${p.provides}`);
    }
    lines.push('');
  }

  // ── How it works ─────────────────────────────────────────────
  let howItWorksDone = false;
  try {
    const section = await synthesizeHowItWorks(manifest, codebaseContext);
    if (section) { lines.push(section, ''); howItWorksDone = true; }
  } catch { /* non-fatal — fall through to deterministic */ }
  if (!howItWorksDone) {
    // Deterministic fallback: rule titles only, no error messages
    const rules = Object.values(manifest.rules ?? {});
    if (rules.length > 0) {
      lines.push('## How it works', '');
      for (const rule of rules) {
        lines.push(`- ${rule.title}`);
      }
      lines.push('');
    }
  }

  // ── Key concepts ─────────────────────────────────────────────
  let keyConceptsDone = false;
  try {
    const section = await synthesizeKeyConcepts(manifest, codebaseContext);
    if (section) { lines.push(section, ''); keyConceptsDone = true; }
  } catch { /* non-fatal — fall through to deterministic */ }
  if (!keyConceptsDone) {
    // Deterministic fallback: flat bullet list of described entities
    const entities = Object.entries(manifest.dataModel ?? {});
    const described = entities.filter(([, e]) => e.description);
    if (described.length > 0) {
      lines.push('## Key concepts', '');
      for (const [ename, entity] of described) {
        lines.push(`- **${ename}** — ${entity.description}`);
        if (entity.notes) lines.push(`  ${entity.notes}`);
      }
      lines.push('');
    }
  }

  // ── Diagrams ─────────────────────────────────────────────────
  const diagrams = generateDiagramsSection(manifest);
  if (diagrams) lines.push(diagrams);

  // ── Setup ────────────────────────────────────────────────────
  const envVars = new Set<string>();
  for (const rule of Object.values(manifest.rules ?? {})) {
    for (const m of (rule.condition ?? '').matchAll(/env\(([^)]+)\)/g)) {
      envVars.add(m[1]);
    }
  }
  if (envVars.size > 0) {
    lines.push('## Setup', '');
    lines.push('Required environment variables:', '');
    for (const v of envVars) {
      lines.push(`- \`${v}\``);
    }
    lines.push('');
  }

  // Sentinel lets compile-spec detect whether this file is still machine-managed.
  // If a user removes or edits past this line, uptocode treats the README as
  // hand-authored and stops overwriting it.
  const sentinel = '<!-- uptocode:managed -->\n';
  return sentinel + lines.join('\n').trimEnd() + '\n';
}

// ── generate-readme (full LLM rewrite from requirements.md) ──────────────────

function buildPrompt(requirementsContent: string, projectName: string, codebaseContext?: string): string {
  const codeSection = codebaseContext
    ? `\nCurrent codebase (nav structure, routes, domain logic):\n${codebaseContext}\n`
    : '';

  return `You are writing a README.md for a software project. The project is described in the spec below.

Write a clear, friendly README that a non-technical person could understand. Do NOT use jargon. Do NOT mention UpToCode, manifest.json, requirements.md, or any internal tooling.

The README should include:
1. A one-line headline describing what the app does
2. A short paragraph (2-3 sentences) explaining what problem it solves and who it's for
3. A "Features" section listing the key things users can do (plain English, bullet points) — use real feature names from the codebase if provided (e.g. actual nav section names like "AI Assist")
4. A "Getting started" section — if there are environment variables in the spec, list them as setup steps; otherwise keep this brief
5. Nothing else — no badges, no license section, no contributing guide

Project name: ${projectName}

Spec:
${requirementsContent}
${codeSection}
Output ONLY the README.md content. No preamble, no explanation.`;
}

export async function generateProjectReadme(
  requirementsContent: string,
  projectName: string,
  apiKey: string,
  codebaseContext?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPrompt(requirementsContent, projectName, codebaseContext) }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude');

  return stripFences(content.text);
}
