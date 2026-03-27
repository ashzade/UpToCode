/**
 * Generates user-friendly Mermaid diagrams from a compiled manifest.
 *
 * Two narrative diagrams:
 *   1. Content pipeline  — how content enters, is analyzed, and becomes knowledge
 *   2. User interactions — what a user sees and can do with that knowledge
 *
 * Plus an optional technical appendix:
 *   3. Document lifecycle — state machine transitions
 *
 * All generation is deterministic; no LLM call required.
 */

import { Manifest, Actor } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip quotes/brackets that break Mermaid labels. */
function safe(s: string): string {
  return s.replace(/["\[\]{}|<>]/g, '').trim();
}

/** Truncate a string to fit inside a diagram node label. */
function trunc(s: string, max = 35): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Split external providers into "content sources" and "AI analyzers".
 * Heuristic: a provider is an AI analyzer if any of its methods are named
 * analyze/generate/detect/identify/suggest/summarize.
 */
function classifyProviders(manifest: Manifest): {
  sources: string[];
  analyzers: string[];
} {
  const AI_METHOD_PREFIXES = ['analyze', 'generate', 'detect', 'identify', 'suggest', 'summarize', 'classify'];
  const sources: string[] = [];
  const analyzers: string[] = [];

  for (const [name, provider] of Object.entries(manifest.externalProviders ?? {})) {
    const isAI = provider.methods.some(m =>
      AI_METHOD_PREFIXES.some(prefix => m.name.toLowerCase().startsWith(prefix))
    );
    if (isAI) analyzers.push(name);
    else sources.push(name);
  }

  return { sources, analyzers };
}

/**
 * Return real (table-backed) entities: those with at least one field.
 * Optionally filtered to those written by a given actor.
 */
function realEntities(manifest: Manifest, writtenBy?: string): string[] {
  const all = Object.entries(manifest.dataModel ?? {})
    .filter(([, e]) => Object.keys(e.fields ?? {}).length > 0)
    .map(([name]) => name);

  if (!writtenBy) return all;

  const actor: Actor | undefined = manifest.actors?.[writtenBy];
  if (!actor) return [];
  if (actor.write === '*') return all;
  if (actor.write === 'none' || !Array.isArray(actor.write)) return [];

  const written = new Set((actor.write as string[]).map(w => w.split('.')[0]));
  return all.filter(e => written.has(e));
}

/**
 * Convert a technical write-access token (e.g. "tasks.done", "revalidation_requests")
 * to a friendly action label for the user flow diagram.
 */
const ACTION_LABELS: Record<string, string> = {
  'tasks.done':             'Complete tasks',
  'tasks.accepted':         'Accept suggested tasks',
  'tasks.deleted':          'Delete tasks',
  'tasks':                  'Manage tasks',
  'corrections':            'Correct AI extractions',
  'revalidation_requests':  'Request re-analysis',
  'documents.owner':        'Assign document owner',
  'documents.scope':        'Set document scope',
  'documents.reprocess':    'Reprocess a document',
  'scopes':                 'Manage scopes / filters',
  'scope_tags':             'Tag scopes',
  'conflicts':              'Resolve conflicts',
  'knowledge_gaps':         'Answer knowledge gaps',
};

function friendlyAction(token: string): string {
  if (ACTION_LABELS[token]) return ACTION_LABELS[token];
  // Fall back: snake_case → Title Case, strip _s
  return token
    .split(/[._]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Friendly display name for a data entity — drop common suffixes for brevity.
 */
function entityLabel(name: string): string {
  return name
    .replace(/Request$/, '')
    .replace(/History$/, ' History')
    .replace(/Mention$/, ' Mention')
    .replace(/Cache$/, ' Cache')
    // Insert space before uppercase runs: KnowledgeGap → Knowledge Gap
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ── 1. Content pipeline ───────────────────────────────────────────────────────

export function generateContentPipelineDiagram(manifest: Manifest): string | null {
  const { sources, analyzers } = classifyProviders(manifest);

  // Find the actor that does the writing (SystemProcessor-like)
  const processorEntry = Object.entries(manifest.actors ?? {}).find(([, a]) => {
    const w = a.write;
    return Array.isArray(w) && w.length > 3;
  });
  const processorName = processorEntry?.[0];

  // Entities produced by the processor
  const outputs = processorName
    ? realEntities(manifest, processorName)
    : realEntities(manifest);

  if (sources.length === 0 && analyzers.length === 0) return null;

  // Build the diagram
  const lines: string[] = ['flowchart TD'];

  // Source subgraph
  if (sources.length > 0) {
    lines.push('    subgraph Sources["📥 Content Sources"]');
    for (const s of sources) {
      const label = safe(trunc(manifest.externalProviders[s]?.provides ?? s, 30));
      lines.push(`        ${s}["${safe(s)}\n${label}"]`);
    }
    lines.push('    end');
  }

  // Ingestion node (state machine pending state)
  const pendingDesc = manifest.stateMachine?.states?.['PENDING'] ?? 'queued for analysis';
  lines.push(`    Ingest[/"📄 Document\n${safe(trunc(pendingDesc, 30))}\"/]`);

  // AI analyzer subgraph
  if (analyzers.length > 0) {
    lines.push('    subgraph AI["🤖 AI Analysis"]');
    for (const a of analyzers) {
      lines.push(`        ${a}["${safe(a)}"]`);
    }
    lines.push('    end');
  }

  // Knowledge subgraph — cap at 8 entities
  const shownOutputs = outputs.slice(0, 8);
  if (shownOutputs.length > 0) {
    lines.push('    subgraph Knowledge["🗂️ Structured Knowledge"]');
    for (const e of shownOutputs) {
      lines.push(`        ${e}[("${entityLabel(e)}")]`);
    }
    lines.push('    end');
  }

  // Edges: sources → ingest
  for (const s of sources) lines.push(`    ${s} --> Ingest`);

  // Edges: ingest → analyzers (or directly to knowledge if no analyzers)
  if (analyzers.length > 0) {
    for (const a of analyzers) lines.push(`    Ingest --> ${a}`);
    // Edges: analyzers → knowledge
    for (const a of analyzers) {
      for (const e of shownOutputs) lines.push(`    ${a} --> ${e}`);
    }
  } else {
    for (const e of shownOutputs) lines.push(`    Ingest --> ${e}`);
  }

  // State machine annotation
  if (manifest.stateMachine?.transitions?.length) {
    const processedDesc = manifest.stateMachine.states?.['PROCESSED'] ?? 'analysis stored';
    lines.push(`    Ingest -. "analysis complete" .-> Done{{"✅ ${safe(trunc(processedDesc, 28))}"}}`);
  }

  return lines.join('\n');
}

// ── 2. User interactions ──────────────────────────────────────────────────────

export function generateUserFlowDiagram(manifest: Manifest): string | null {
  // Find the "consumer" actor — the one with read=* or the most read access
  const consumerEntry = Object.entries(manifest.actors ?? {}).find(([, a]) => a.read === '*')
    ?? Object.entries(manifest.actors ?? {}).find(([, a]) => Array.isArray(a.read) && (a.read as string[]).length > 3);

  if (!consumerEntry) return null;
  const [, consumer] = consumerEntry;

  // Derive what the user reads (viewable outputs)
  const viewable = realEntities(manifest).slice(0, 10);

  // Derive user actions from consumer write list
  const writeTokens = Array.isArray(consumer.write)
    ? (consumer.write as string[])
    : consumer.write === '*'
      ? []  // too broad to list
      : [];

  const actions = writeTokens.map(friendlyAction).slice(0, 8);

  if (viewable.length === 0 && actions.length === 0) return null;

  const lines: string[] = ['flowchart LR'];

  lines.push('    User(["👤 PM / User"])');

  // "See" subgraph
  if (viewable.length > 0) {
    lines.push('    subgraph View["📊 What they see"]');
    for (const e of viewable) {
      lines.push(`        ${e}["${entityLabel(e)}"]`);
    }
    lines.push('    end');
    lines.push('    User --> View');
  }

  // "Do" subgraph
  if (actions.length > 0) {
    lines.push('    subgraph Act["✏️ What they can do"]');
    for (let i = 0; i < actions.length; i++) {
      lines.push(`        A${i}["${safe(actions[i])}"]`);
    }
    lines.push('    end');
    lines.push('    User --> Act');
  }

  return lines.join('\n');
}

// ── 3. State lifecycle (technical appendix) ───────────────────────────────────

export function generateStateDiagram(manifest: Manifest): string | null {
  const sm = manifest.stateMachine;
  if (!sm?.transitions?.length) return null;

  const lines: string[] = ['stateDiagram-v2'];

  const froms = new Set(sm.transitions.map(t => t.from));
  const tos   = new Set(sm.transitions.map(t => t.to));
  for (const s of tos) {
    if (!froms.has(s)) lines.push(`    [*] --> ${s}`);
  }

  for (const t of sm.transitions) {
    const label = t.trigger
      ? ': ' + (t.trigger.length > 40 ? t.trigger.slice(0, 37) + '…' : t.trigger)
      : '';
    lines.push(`    ${t.from} --> ${t.to}${label}`);
  }

  for (const [state, desc] of Object.entries(sm.states ?? {})) {
    if (desc) {
      lines.push(`    note right of ${state}`);
      lines.push(`        ${safe(desc)}`);
      lines.push(`    end note`);
    }
  }

  return lines.join('\n');
}

// ── Public entry point ────────────────────────────────────────────────────────

export function generateDiagramsSection(manifest: Manifest): string {
  const parts: string[] = ['## Diagrams', ''];

  const pipeline = generateContentPipelineDiagram(manifest);
  if (pipeline) {
    parts.push('### Content pipeline', '');
    parts.push('How content enters the system, is analyzed by AI, and becomes structured knowledge.', '');
    parts.push('```mermaid', pipeline, '```', '');
  }

  const userFlow = generateUserFlowDiagram(manifest);
  if (userFlow) {
    parts.push('### User interactions', '');
    parts.push('What a user can view and act on through the dashboard.', '');
    parts.push('```mermaid', userFlow, '```', '');
  }

  const state = generateStateDiagram(manifest);
  if (state) {
    parts.push('### Document lifecycle', '');
    parts.push('States a document moves through from ingestion to processed output.', '');
    parts.push('```mermaid', state, '```', '');
  }

  return parts.length > 2 ? parts.join('\n') : '';
}
