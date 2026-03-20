/**
 * Generates a plain-English README.md for the user's project from their spec.
 *
 * Reads requirements.md and calls Claude to produce a friendly, non-technical
 * README describing what the app does, who it's for, and how to get started.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Manifest } from '../types';

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
