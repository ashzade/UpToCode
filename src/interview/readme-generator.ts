/**
 * Generates a plain-English README.md for the user's project from their spec.
 *
 * Reads requirements.md and calls Claude to produce a friendly, non-technical
 * README describing what the app does, who it's for, and how to get started.
 *
 * Also exports buildReadmeFromManifest — a deterministic, zero-latency version
 * used as a compile-spec side effect to keep README.md always in sync.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Manifest } from '../types';
import { generateDiagramsSection } from './diagram-generator';

/**
 * Build a structured README.md from a compiled manifest with no LLM call.
 * Called automatically by compile-spec so the README is always current.
 */
export function buildReadmeFromManifest(manifest: Manifest): string {
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

  // ── Rules ────────────────────────────────────────────────────
  const rulesByType: Record<string, typeof manifest.rules[string][]> = {};
  for (const rule of Object.values(manifest.rules ?? {})) {
    (rulesByType[rule.type] ??= []).push(rule);
  }
  for (const type of ['Business', 'Validation', 'Security'] as const) {
    const group = rulesByType[type];
    if (!group?.length) continue;
    lines.push(`## ${type} rules`, '');
    for (const rule of group) {
      const enforcement = manifest.enforcement.find(e => e.ruleId === rule.id);
      const severity = enforcement ? ` _(${enforcement.severity})_` : '';
      lines.push(`- **${rule.title}**${severity} — ${rule.message}`);
    }
    lines.push('');
  }

  // ── Information architecture ──────────────────────────────────
  const entities = Object.entries(manifest.dataModel ?? {});
  const describedEntities = entities.filter(([, e]) => e.description);
  if (describedEntities.length > 0) {
    lines.push('## Information architecture', '');
    for (const [ename, entity] of describedEntities) {
      lines.push(`- **${ename}** — ${entity.description}`);
      if (entity.notes) {
        lines.push(`  ${entity.notes}`);
      }
    }
    lines.push('');
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

  let readme = content.text.trim();
  // Strip accidental code fences
  if (readme.startsWith('```')) {
    readme = readme.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim();
  }
  return readme;
}
