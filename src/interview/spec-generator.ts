/**
 * Spec generator for the Interview Agent.
 *
 * Takes a CodeAnalysis + natural language description, calls Claude to produce
 * a requirements.md, validates it parses cleanly, and retries with error
 * feedback if it doesn't. Up to MAX_RETRIES attempts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { parse } from '../index';
import { CodeAnalysis } from './code-analyzer';

const MAX_RETRIES = 3;

export interface GenerateSpecOptions {
  analysis: CodeAnalysis;
  description?: string;
  featureName?: string;
  owner?: string;
  apiKey: string;
}

export interface GenerateSpecResult {
  spec: string;
  parseAttempts: number;
  warnings: string[];
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You generate requirements.md files. Your output must be parseable by a strict machine parser. Follow the format EXACTLY as shown in the example below — no deviations.

## CRITICAL FORMAT RULES

1. Output ONLY the requirements.md content. No explanation, no preamble, no code fences.
2. The ONLY allowed top-level sections (## headings) are: External State Providers, State Machine, Actors & Access, Data Model, Computed Properties, Logic Rules. No other sections.
3. Data Model entities MAY have, immediately after the \`### EntityName\` heading: (a) one optional italic summary line \`_Short one-liner._\`, and (b) optional multi-line prose notes explaining how the entity works (before the first field line). Fields then follow using ONLY this syntax: \`field_name: type | modifier | modifier\` — NO markdown tables, NO bullets, NO bold in fields.
4. Logic Rules use ONLY bare key-value lines (Type:, Entity:, Condition:, Message:) — NO bullets, NO bold, NO dashes.
5. State Machine transitions use ONLY \`#### FROM → TO\` headings with bare Trigger:/Guard:/Action: lines — NO code blocks, NO ASCII art.
6. Computed Properties use ONLY bare key-value lines (Aggregate:, Entity:, Filter:, Window:) — NO bullets, NO bold.
7. Condition fields MUST use predicate grammar — see rules below.
8. version MUST be semver: 1.0.0 not "generated" or a date.

## CONDITION GRAMMAR — violations throw parse errors

Every Condition: and Filter: value MUST be built from ONLY these tokens:
- \`entity.<field>\` — field on the entity (REQUIRED prefix — never bare field name)
- \`actor.type\` or \`actor.id\`
- \`env(VAR_NAME)\` — env var check (NEVER bare VAR_NAME like ANTHROPIC_API_KEY)
- \`Provider.method(arg)\` — external provider call
- \`NOW()\`, \`NOW() - INTERVAL(n, unit)\`
- \`'string'\`, number, \`true\`, \`false\`
- A bare snake_case name that is declared in Computed Properties
- Operators: \`==\` \`!=\` \`>\` \`<\` \`>=\` \`<=\` \`AND\` \`OR\` \`NOT\` \`(\` \`)\`

FORBIDDEN in conditions (parse errors):
- Bare field names without entity. prefix: \`status == 'x'\` ✗ → \`entity.status == 'x'\` ✓
- Bare env var names: \`ANTHROPIC_API_KEY != ''\` ✗ → \`env(ANTHROPIC_API_KEY) != ''\` ✓
- Python/JS functions: \`len()\`, \`abs()\`, \`str.startswith()\` ✗
- Prose: \`file is not binary\`, \`does not start with\` ✗

## COMPLETE WORKING EXAMPLE

---
feature_id: document_processing
version: 1.0.0
status: draft
owner: ash-zade
depends_on:
  - anthropic_api
  - google_drive_api
  - slack_api
tags:
  - ingestion
  - pipeline
---

# Document Processing

Ingests content from Google Drive, Slack, and local files, analyzes with Claude, and stores structured output in SQLite.

## External State Providers

### AnthropicAPI
source: anthropic-api
provides: Claude AI analysis of document content
lookup_key: document_id
Methods:
  - analyze(name: string, doc_type: string, content: string): json

### GoogleDriveAPI
source: google-drive-api
provides: raw text content of Google Workspace files
lookup_key: file_path
Methods:
  - read_gdoc(file_path: string): string
  - get_drive_url(file_path: string): string

### SlackAPI
source: slack-api
provides: historical channel messages bundled by day
lookup_key: channel
Methods:
  - fetch_all_channels(since_days: integer): json

## State Machine

### States

- PENDING – document record written, analysis not yet attempted
- PROCESSED – analysis succeeded and all output stored
- FAILED – analysis was attempted but raised an exception

### Transitions

#### PENDING → PROCESSED
Trigger: analyze_document returns successfully
Guard: RULE_01
Action: emit_event(ANALYSIS_COMPLETE), set_field(entity.status, 'processed')

#### PENDING → FAILED
Trigger: analyze_document raises an exception
Action: emit_event(ANALYSIS_FAILED), set_field(entity.status, 'failed')

#### FAILED → PENDING
Trigger: reprocess requested with force=True
Action: set_field(entity.status, 'pending')

#### PROCESSED → PENDING
Trigger: file mtime changed since last processing
Guard: RULE_02
Action: set_field(entity.status, 'pending')

## Actors & Access

### SystemProcessor
Read: documents, analyses, entities
Write: documents, analyses, entities, tasks

### DashboardAPI
Read: *
Write: tasks.done, scopes, documents.reprocess

### Logic Enforcement

RULE_01: MEDIUM → reject
RULE_02: LOW → audit_log
RULE_03: HIGH → reject
RULE_04: LOW → audit_log
RULE_05: MEDIUM → reject

## Data Model

### Document
_A file or Slack export ingested into the system. Tracks processing status and links to raw content._

id:             string | primary | auto-gen
name:           string | required
file_path:      string | unique | required | indexed
doc_type:       string | nullable
source_type:    enum('meeting', 'document', 'slack', 'calendar') | required | default(meeting)
meeting_date:   string | nullable
file_mtime:     decimal | nullable
processed_at:   string | nullable
drive_url:      string | nullable
raw_content:    string | nullable
status:         enum('pending', 'processed', 'failed') | required | default(pending)

### Analysis
_Structured output extracted from a document by Claude: summary, decisions, action items, blockers, and insights._

id:             integer | primary | auto-gen
document_id:    string | required | unique | indexed | fk(Document.id, one-to-one)
summary:        string | nullable
key_updates:    string | required | default([])
decisions:      string | required | default([])
action_items:   string | required | default([])
my_tasks:       string | required | default([])
blockers:       string | required | default([])
created_at:     timestamp | auto-gen

### Task
_An action item surfaced from a document or suggested by Claude, tracked to completion._

id:             integer | primary | auto-gen
document_id:    string | required | indexed | fk(Document.id, many-to-one)
text:           string | required
done:           boolean | required | default(false)
source_type:    string | nullable
created_at:     timestamp | auto-gen

## Computed Properties

### is_stale
Aggregate: EXISTS
Entity: Document
Filter: entity.status == 'processed' AND entity.file_mtime != entity.file_mtime
Window: none

### pending_task_count
Aggregate: COUNT
Entity: Task
Filter: entity.done == false
Window: none

## Logic Rules

### Validation Rules

#### RULE_01: Content Must Be Non-Empty
Type: Validation
Entity: Document
Condition: entity.raw_content != '' AND entity.raw_content != 'null'
Message: No content extracted from document; skipping analysis.

#### RULE_03: Supported Extension Required
Type: Validation
Entity: Document
Condition: entity.doc_type != ''
Message: File type is not supported or file is binary; skipping.

### Business Rules

#### RULE_02: Skip Unmodified Processed Documents
Type: Business
Entity: Document
Condition: entity.status == 'processed' AND is_stale == false
Message: Document unchanged since last processing; skipping.

#### RULE_04: Year Filter for Meeting Sources
Type: Business
Entity: Document
Condition: entity.source_type == 'meeting' AND entity.meeting_date != ''
Message: Document outside the configured filter year; skipping.

#### RULE_05: API Key Required for Analysis
Type: Business
Entity: Document
Condition: env(ANTHROPIC_API_KEY) != '' AND entity.status == 'pending'
Message: Anthropic API key not configured; analysis cannot proceed.

---

Now generate a requirements.md for the feature described by the user. Follow the EXACT same format as the example above. Same heading levels, same key-value syntax, same field definition syntax. No additional sections.`;
}

function buildUserPrompt(opts: GenerateSpecOptions): string {
  const { analysis, description, featureName } = opts;

  const lines: string[] = [];

  if (description) {
    lines.push(`## Feature Description\n${description}\n`);
  }

  if (analysis.entityNames.length > 0) {
    lines.push(`## Detected Entities\n${analysis.entityNames.join(', ')}\n`);
  }

  if (analysis.routes.length > 0) {
    const routeList = analysis.routes
      .slice(0, 20)
      .map(r => `${r.method} ${r.path}`)
      .join('\n');
    lines.push(`## HTTP Routes\n${routeList}\n`);
  }

  if (analysis.statusEnums.length > 0) {
    const enumList = analysis.statusEnums
      .map(s => `${s.field}: ${s.values.join(', ')}`)
      .join('\n');
    lines.push(`## State/Status Fields\n${enumList}\n`);
  }

  if (analysis.externalApis.length > 0) {
    lines.push(`## External APIs Used\n${analysis.externalApis.join(', ')}\n`);
  }

  if (analysis.envVarNames.length > 0) {
    lines.push(`## Environment Variables\n${analysis.envVarNames.join(', ')}\n`);
  }

  // Key processing functions
  const funcs = analysis.facts.filter(f => f.kind === 'function').slice(0, 10);
  if (funcs.length > 0) {
    lines.push(`## Key Processing Functions\n${funcs.map(f => f.name).join(', ')}\n`);
  }

  // Auth patterns
  const authFacts = analysis.facts.filter(f => f.kind === 'auth_pattern').slice(0, 5);
  if (authFacts.length > 0) {
    lines.push(`## Auth Patterns Found\n${authFacts.map(f => f.name).join('\n')}\n`);
  }

  const featureHint = featureName ? `Feature name: "${featureName}"` : '';
  const ownerHint = opts.owner ? `Owner: ${opts.owner}` : '';

  lines.push(
    `${featureHint}\n${ownerHint}\n`.trim(),
    `Generate a complete requirements.md for this feature. Produce ONLY the requirements.md content — no explanation, no code fences, no preamble.`
  );

  return lines.join('\n');
}

// ── Generator ──────────────────────────────────────────────────────────────────

export async function generateSpec(opts: GenerateSpecOptions): Promise<GenerateSpecResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const warnings: string[] = [];
  let lastSpec = '';
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const userContent = attempt === 1
      ? buildUserPrompt(opts)
      : buildUserPrompt(opts) +
        `\n\n## Previous Attempt Failed\nThe spec you generated had this parse error:\n\`\`\`\n${lastError}\n\`\`\`\nFix the error and regenerate the complete spec.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: userContent }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      warnings.push(`Attempt ${attempt}: unexpected response type`);
      continue;
    }

    // Strip accidental code fences
    let spec = content.text.trim();
    if (spec.startsWith('```')) {
      spec = spec.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    lastSpec = spec;

    // Validate it parses
    try {
      parse(spec);
      return { spec, parseAttempts: attempt, warnings };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      warnings.push(`Attempt ${attempt} parse error: ${lastError}`);
    }
  }

  // Return best effort even if parsing failed
  warnings.push(`Spec did not parse cleanly after ${MAX_RETRIES} attempts. Returning last attempt for manual review.`);
  return { spec: lastSpec, parseAttempts: MAX_RETRIES, warnings };
}
