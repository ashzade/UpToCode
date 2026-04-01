/**
 * Generates user-friendly Mermaid diagrams from a compiled manifest.
 *
 * Two narrative diagrams:
 *   1. Flow diagram  — how the system processes a request or ingests data
 *   2. User interactions — what a user sees and can do
 *
 * Plus an optional technical appendix:
 *   3. Entity lifecycle — state machine transitions for the primary entity
 *
 * Titles and descriptions are derived from the manifest; no hardcoded
 * project-specific labels. All generation is deterministic; no LLM call.
 */

import { Manifest, Actor } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip quotes/brackets that break Mermaid labels. */
function safe(s: string): string {
  return s.replace(/["\[\]{}|<>]/g, '').trim();
}

/**
 * Convert an entity name to a valid Mermaid node ID.
 * Mermaid node IDs must be alphanumeric + underscores only.
 * E.g. "ParsedQuery (in-memory)" → "ParsedQueryInMemory"
 */
function nodeId(name: string): string {
  return name
    .replace(/\(in-memory\)/gi, 'InMemory')
    .replace(/[^a-zA-Z0-9_]/g, '');
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

// ── Title / description inference ─────────────────────────────────────────────

/**
 * Infer a title and one-line description for the main flow diagram based on
 * what kinds of external providers the project uses.
 *
 * - Pure search/fetch projects (no AI analyzers): "Request flow"
 * - Projects with AI analysis on top of external data: "How it works"
 * - AI-only projects (no external data sources): "Processing pipeline"
 * - Fallback: feature name + "— data flow"
 */
function inferFlowDiagramMeta(manifest: Manifest): { title: string; description: string } {
  const { sources, analyzers } = classifyProviders(manifest);
  const featureName = manifest.feature?.name ?? 'the system';

  if (sources.length > 0 && analyzers.length > 0) {
    const sourceList = sources.join(', ');
    const analyzerList = analyzers.join(', ');
    return {
      title: 'How it works',
      description: `How a request flows from user input through ${sourceList}, is processed by ${analyzerList}, and returns results.`,
    };
  }

  if (sources.length > 0) {
    const sourceList = sources.join(', ');
    return {
      title: 'Request flow',
      description: `How user input is interpreted, sent to ${sourceList}, and results are returned.`,
    };
  }

  if (analyzers.length > 0) {
    const analyzerList = analyzers.join(', ');
    return {
      title: 'Processing pipeline',
      description: `How data is ingested and processed by ${analyzerList} to produce structured output.`,
    };
  }

  return {
    title: `${featureName} — data flow`,
    description: `How ${featureName} processes and stores data.`,
  };
}

/**
 * Infer a title and description for the state machine diagram.
 * Uses the primary entity written by the system processor as the subject.
 * Falls back to "Item" if no clear entity can be found.
 */
function inferStateDiagramMeta(manifest: Manifest): { title: string; description: string } {
  const processorEntry = Object.entries(manifest.actors ?? {}).find(([, a]) => {
    const w = a.write;
    return Array.isArray(w) && w.length > 3;
  });

  const primaryEntities = processorEntry
    ? realEntities(manifest, processorEntry[0])
    : realEntities(manifest);

  const subject = primaryEntities.length > 0
    ? entityLabel(primaryEntities[0])
    : 'Item';

  return {
    title: `${subject} lifecycle`,
    description: `States a ${subject.toLowerCase()} moves through from creation to completion.`,
  };
}

/**
 * Infer a display name for the primary user actor.
 * Uses the actor's key from the manifest, falling back to "User".
 */
function inferUserActorLabel(manifest: Manifest): string {
  const consumerEntry =
    Object.entries(manifest.actors ?? {}).find(([, a]) => a.read === '*') ??
    Object.entries(manifest.actors ?? {}).find(([, a]) => Array.isArray(a.read) && (a.read as string[]).length > 3);

  return consumerEntry ? entityLabel(consumerEntry[0]) : 'User';
}

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
      lines.push(`        ${nodeId(e)}[("${entityLabel(e)}")]`);
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
      for (const e of shownOutputs) lines.push(`    ${a} --> ${nodeId(e)}`);
    }
  } else {
    for (const e of shownOutputs) lines.push(`    Ingest --> ${nodeId(e)}`);
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

  const actorLabel = inferUserActorLabel(manifest);
  lines.push(`    User(["👤 ${safe(actorLabel)}"])`);

  // "See" subgraph
  if (viewable.length > 0) {
    lines.push('    subgraph View["📊 What they see"]');
    for (const e of viewable) {
      lines.push(`        ${nodeId(e)}["${entityLabel(e)}"]`);
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

  // Initial states: prefer well-known names, fall back to states with no incoming transitions
  const INITIAL_NAMES = ['PENDING', 'INIT', 'NEW', 'CREATED', 'DRAFT', 'OPEN', 'SUBMITTED'];
  const allStates = new Set([...froms, ...tos]);
  const initialState =
    INITIAL_NAMES.find(s => allStates.has(s)) ??
    [...froms].find(s => !tos.has(s)) ??
    sm.transitions[0].from;
  lines.push(`    [*] --> ${initialState}`);

  // Terminal states: appear as `to` but never as `from` — add end marker
  for (const s of tos) {
    if (!froms.has(s)) lines.push(`    ${s} --> [*]`);
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
    const { title, description } = inferFlowDiagramMeta(manifest);
    parts.push(`### ${title}`, '');
    parts.push(description, '');
    parts.push('```mermaid', pipeline, '```', '');
  }

  const userFlow = generateUserFlowDiagram(manifest);
  if (userFlow) {
    const actorLabel = inferUserActorLabel(manifest);
    parts.push('### User interactions', '');
    parts.push(`What ${actorLabel.toLowerCase()}s can view and interact with.`, '');
    parts.push('```mermaid', userFlow, '```', '');
  }

  const state = generateStateDiagram(manifest);
  if (state) {
    const { title, description } = inferStateDiagramMeta(manifest);
    parts.push(`### ${title}`, '');
    parts.push(description, '');
    parts.push('```mermaid', state, '```', '');
  }

  return parts.length > 2 ? parts.join('\n') : '';
}
