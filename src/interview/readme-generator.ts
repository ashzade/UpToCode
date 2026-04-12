/**
 * Generates a plain-English README.md for the user's project from their spec.
 *
 * Reads requirements.md and calls Claude to produce a friendly, non-technical
 * README describing what the app does, who it's for, and how to get started.
 *
 * Also exports buildReadmeFromManifest — called automatically by compile-spec
 * to keep README.md in sync. When an API key is available it calls Claude to
 * synthesize plain-English "How it works" and "Key concepts" sections from the
 * raw manifest data. Without a key it falls back to a deterministic render.
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

async function synthesizeHowItWorks(manifest: Manifest, apiKey: string): Promise<string> {
  const rules = Object.values(manifest.rules ?? {});
  if (rules.length === 0) return '';

  const ruleList = rules
    .map(r => `- ${r.title}: ${r.message}`)
    .join('\n');

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You are writing a "How it works" section for a user-facing README for a software product.

Product: ${manifest.feature.name}
Purpose: ${manifest.feature.intent ?? ''}

Given these internal app rules, explain what the app does automatically and what it needs to function. Write for a non-technical user — someone who wants to understand the product, not build it.

Rules (internal):
${ruleList}

Write a "## How it works" section. Use 3–6 plain-English bullet points. Each bullet should describe a behaviour or requirement from the user's perspective. Don't use words like "rule", "condition", "validation", "entity", or "null". Don't mention error messages. Start each bullet with "**" to bold the key phrase, then "—" and an explanation.

Output ONLY the markdown section. No preamble.`,
    }],
  });

  const content = msg.content[0];
  if (content.type !== 'text') return '';
  return stripFences(content.text) + '\n';
}

async function synthesizeKeyConcepts(manifest: Manifest, apiKey: string): Promise<string> {
  const entities = Object.entries(manifest.dataModel ?? {}).filter(([, e]) => e.description);
  if (entities.length === 0) return '';

  const entityList = entities
    .map(([name, e]) => `- ${name}: ${e.description}${e.notes ? ` (${e.notes})` : ''}`)
    .join('\n');

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are writing a "Key concepts" section for a user-facing README for a software product.

Product: ${manifest.feature.name}
Purpose: ${manifest.feature.intent ?? ''}

Given these internal data concepts, explain the important ones in plain English from a user's perspective — what they see and interact with, not how the database is structured.

Skip purely internal/technical concepts like caches, sync trackers, version histories, audit logs, and join tables. Focus on the concepts a user would recognise or care about.

Concepts (internal):
${entityList}

Write a "## Key concepts" section. Start with one sentence introducing what this product tracks. Then write a bullet per important concept: "**Name** — plain-English explanation of what this is and why it matters to the user." Explain any non-obvious terminology (e.g. if there's an "SME" concept, say what SME means). Under 300 words total.

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
 * When apiKey is provided, "How it works" and "Key concepts" are synthesized by
 * Claude Haiku from the raw manifest data so they read like product documentation
 * rather than database definitions. Without a key both sections fall back to a
 * deterministic render (rule titles / entity descriptions verbatim).
 */
export async function buildReadmeFromManifest(manifest: Manifest, apiKey?: string): Promise<string> {
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

  // ── Diagrams ─────────────────────────────────────────────────
  const diagrams = generateDiagramsSection(manifest);
  if (diagrams) lines.push(diagrams);

  // ── How it works ─────────────────────────────────────────────
  if (apiKey) {
    try {
      const section = await synthesizeHowItWorks(manifest, apiKey);
      if (section) lines.push(section, '');
    } catch { /* non-fatal — skip section on failure */ }
  } else {
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
  if (apiKey) {
    try {
      const section = await synthesizeKeyConcepts(manifest, apiKey);
      if (section) lines.push(section, '');
    } catch { /* non-fatal — fall through to deterministic */ }
  } else {
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

  return lines.join('\n').trimEnd() + '\n';
}

// ── generate-readme (full LLM rewrite from requirements.md) ──────────────────

function buildPrompt(requirementsContent: string, projectName: string): string {
  return `You are writing a README.md for a software project. The project is described in the spec below.

Write a clear, friendly README that a non-technical person could understand. Do NOT use jargon. Do NOT mention UpToCode, manifest.json, requirements.md, or any internal tooling.

The README should include:
1. A one-line headline describing what the app does
2. A short paragraph (2-3 sentences) explaining what problem it solves and who it's for
3. A "Features" section listing the key things users can do (plain English, bullet points)
4. A "Getting started" section — if there are environment variables in the spec, list them as setup steps; otherwise keep this brief
5. Nothing else — no badges, no license section, no contributing guide

Project name: ${projectName}

Spec:
${requirementsContent}

Output ONLY the README.md content. No preamble, no explanation.`;
}

export async function generateProjectReadme(
  requirementsContent: string,
  projectName: string,
  apiKey: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPrompt(requirementsContent, projectName) }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude');

  return stripFences(content.text);
}
