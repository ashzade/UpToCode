/**
 * Conversational spec builder.
 *
 * Two-phase flow:
 *   1. get-questions  → returns a prompt for Claude to conduct a plain-English
 *                       interview with the user, one question at a time.
 *   2. build-spec     → takes the collected Q&A transcript, calls Claude API
 *                       to synthesize a valid requirements.md, validates it
 *                       parses cleanly, writes the file.
 */

import Anthropic from '@anthropic-ai/sdk';
import { parse } from '../index';

// ── Interview questions ───────────────────────────────────────────────────────

export interface Question {
  id: string;
  ask: string;
  why: string; // internal — maps to spec section
}

export const INTERVIEW_QUESTIONS: Question[] = [
  {
    id: 'what',
    ask: "What does your app do? Describe it in one or two sentences, like you'd explain it to a friend.",
    why: 'feature intent',
  },
  {
    id: 'users',
    ask: "Who uses the app? Is there just one type of user, or are there different roles — like regular users and admins?",
    why: 'actors',
  },
  {
    id: 'main_thing',
    ask: "What's the main thing your app tracks or stores? For example: orders, signups, posts, documents, jobs. There might be more than one.",
    why: 'data model entities',
  },
  {
    id: 'fields',
    ask: "For each thing you just mentioned — what information do you need to store about it? For example, for a 'signup' you might store: email, name, date they signed up.",
    why: 'data model fields',
  },
  {
    id: 'states',
    ask: "Does anything in your app go through stages or statuses? For example, an order might be: placed → shipped → delivered. A job application might be: submitted → reviewed → accepted or rejected.",
    why: 'state machine',
  },
  {
    id: 'actions',
    ask: "What are the key things someone can do in the app? Walk me through the main actions — both what regular users can do and what admins can do.",
    why: 'transitions and actor access',
  },
  {
    id: 'rules',
    ask: "Are there any rules the app must enforce? Things that should never be allowed to happen. For example: you can't place an order with an empty cart, an invite can't be sent without an email address configured, a user can't be deleted while they have active subscriptions.",
    why: 'logic rules',
  },
  {
    id: 'external',
    ask: "Does the app connect to any outside services? For example: Stripe for payments, SendGrid or Postmark for email, Twilio for SMS, Slack for notifications, Google Drive for documents.",
    why: 'external providers',
  },
  {
    id: 'env_vars',
    ask: "What secret keys or environment variables does the app need to run? For example: STRIPE_SECRET_KEY, SENDGRID_API_KEY, DATABASE_URL.",
    why: 'env var rules',
  },
];

// ── Prompt for Claude to conduct the interview ────────────────────────────────

export function buildInterviewPrompt(projectContext?: string): string {
  const questions = INTERVIEW_QUESTIONS.map((q, i) =>
    `${i + 1}. ${q.ask}`
  ).join('\n');

  const contextLine = projectContext
    ? `\n\nContext about this project: ${projectContext}\n`
    : '';

  return `You are helping someone describe their app so it can be turned into a technical specification. Ask them the following questions one at a time. Wait for their answer before asking the next question. Use their answers to inform follow-up questions where helpful — but don't skip any question entirely.${contextLine}

Keep your tone friendly and conversational. If someone gives a vague answer, gently ask for a concrete example. If they seem unsure, offer a simple example from a different domain to help them think it through.

When you have collected answers to all questions, say exactly:
"Great, I have everything I need. Let me build your spec."

Then call the spec-interview tool with all of the answers.

Here are the questions to ask:

${questions}`;
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

export interface InterviewTranscript {
  what: string;
  users: string;
  main_thing: string;
  fields: string;
  states: string;
  actions: string;
  rules: string;
  external: string;
  env_vars: string;
}

export interface BuildSpecResult {
  spec: string;
  outputPath: string;
  parseAttempts: number;
  warnings: string[];
}

const MAX_RETRIES = 3;

function buildSynthesisSystemPrompt(): string {
  return `You generate requirements.md files from plain-English interview answers. Your output must be parseable by a strict machine parser. Follow the format EXACTLY as shown in the example below — no deviations.

## CRITICAL FORMAT RULES

1. Output ONLY the requirements.md content. No explanation, no preamble, no code fences.
2. The ONLY allowed top-level sections (## headings) are: External State Providers, State Machine, Actors & Access, Data Model, Computed Properties, Logic Rules. No other sections.
3. Data Model fields use ONLY this syntax: \`field_name: type | modifier | modifier\` — NO markdown tables, NO bullets, NO bold.
4. Logic Rules use ONLY bare key-value lines (Type:, Entity:, Condition:, Message:) — NO bullets, NO bold, NO dashes.
5. State Machine transitions use ONLY \`#### FROM → TO\` headings with bare Trigger:/Guard:/Action: lines.
6. Computed Properties use ONLY bare key-value lines (Aggregate:, Entity:, Filter:, Window:).
7. Condition fields MUST use predicate grammar — entity.field, env(VAR), operators ==, !=, AND, OR.
8. version MUST be semver: 1.0.0

## CONDITION GRAMMAR

Every Condition: and Filter: value MUST use:
- \`entity.<field>\` — NEVER a bare field name
- \`env(VAR_NAME)\` — NEVER a bare variable name like STRIPE_KEY
- Operators: == != > < >= <= AND OR NOT

## COMPLETE WORKING EXAMPLE

---
feature_id: waitlist
version: 1.0.0
status: draft
owner: founder
depends_on:
  - email_api
tags:
  - waitlist
---

# Waitlist

Accepts email signups and queues them for admin review. Admins can invite or reject signups.

## External State Providers

### EmailAPI
source: email-api
provides: sends invitation emails to signups
lookup_key: signup_id
Methods:
  - send_invite(email: string): boolean

## State Machine

### States

- PENDING – signup received, not yet reviewed
- INVITED – admin sent an invitation
- REJECTED – admin rejected the signup

### Transitions

#### PENDING → INVITED
Trigger: admin sends invitation
Guard: RULE_01
Action: set_field(entity.status, 'invited'), set_field(entity.invited_at, NOW())

#### PENDING → REJECTED
Trigger: admin rejects signup
Action: set_field(entity.status, 'rejected')

## Actors & Access

### PublicAPI
Read: none
Write: signups

### AdminAPI
Read: *
Write: signups

### Logic Enforcement

RULE_01: HIGH → reject
RULE_02: MEDIUM → reject

## Data Model

### Signup

id:          integer | primary | auto-gen
email:       string  | required | unique | indexed
status:      enum('pending', 'invited', 'rejected') | required | default(pending)
invited_at:  timestamp | nullable
created_at:  timestamp | auto-gen

## Logic Rules

### Validation Rules

#### RULE_01: Email Must Be Non-Empty
Type: Validation
Entity: Signup
Condition: entity.email != ''
Message: Email is required.

### Business Rules

#### RULE_02: API Key Required
Type: Business
Entity: Signup
Condition: env(EMAIL_API_KEY) != '' AND entity.status == 'pending'
Message: Email API key not configured.

---

Now generate a requirements.md from the interview answers the user provides. Match the format exactly. Infer reasonable field types, rules, and state machines from their plain-English descriptions. If they didn't mention something, omit that section rather than hallucinating details.`;
}

function buildSynthesisUserPrompt(transcript: InterviewTranscript, featureName?: string, owner?: string): string {
  return `Here are the interview answers. Generate a complete requirements.md from them.

Feature name: ${featureName ?? 'My App'}
Owner: ${owner ?? 'founder'}

---
Q: What does your app do?
A: ${transcript.what}

Q: Who uses the app? Different roles?
A: ${transcript.users}

Q: What is the main thing the app tracks or stores?
A: ${transcript.main_thing}

Q: What information do you store about each thing?
A: ${transcript.fields}

Q: Does anything go through stages or statuses?
A: ${transcript.states}

Q: What are the key actions someone can do?
A: ${transcript.actions}

Q: Are there rules the app must enforce?
A: ${transcript.rules}

Q: Does the app connect to outside services?
A: ${transcript.external}

Q: What secret keys or env vars does the app need?
A: ${transcript.env_vars}
---

Generate the complete requirements.md now. Output ONLY the requirements.md content.`;
}

export async function buildSpecFromTranscript(
  transcript: InterviewTranscript,
  outputPath: string,
  apiKey: string,
  featureName?: string,
  owner?: string,
): Promise<BuildSpecResult> {
  const client = new Anthropic({ apiKey });
  const warnings: string[] = [];
  let lastSpec = '';
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const userContent = attempt === 1
      ? buildSynthesisUserPrompt(transcript, featureName, owner)
      : buildSynthesisUserPrompt(transcript, featureName, owner) +
        `\n\n## Previous Attempt Failed\nThe spec you generated had this parse error:\n\`\`\`\n${lastError}\n\`\`\`\nFix the error and regenerate the complete spec.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSynthesisSystemPrompt(),
      messages: [{ role: 'user', content: userContent }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      warnings.push(`Attempt ${attempt}: unexpected response type`);
      continue;
    }

    let spec = content.text.trim();
    if (spec.startsWith('```')) {
      spec = spec.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    lastSpec = spec;

    try {
      parse(spec);
      const fs = await import('fs');
      fs.writeFileSync(outputPath, spec, 'utf-8');
      return { spec, outputPath, parseAttempts: attempt, warnings };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      warnings.push(`Attempt ${attempt} parse error: ${lastError}`);
    }
  }

  // Write best-effort output
  const fs = await import('fs');
  fs.writeFileSync(outputPath, lastSpec, 'utf-8');
  warnings.push(`Spec did not parse cleanly after ${MAX_RETRIES} attempts. Saved for manual review.`);
  return { spec: lastSpec, outputPath, parseAttempts: MAX_RETRIES, warnings };
}
