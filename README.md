# Guardian

**Spec enforcement for AI-assisted codebases.**

Guardian turns a plain-English `requirements.md` into a machine-readable contract, then continuously checks that your code, database, and access patterns honour it — automatically, on every edit Claude makes.

Built for teams using Claude Code who want the speed of AI coding without losing control of correctness, security, and scale.

---

## The Problem

When Claude writes code quickly, it doesn't know your rules. It doesn't know which actor is allowed to write which table, what state transitions are valid, or which env vars must be set before an API call. Without enforcement, specs drift from code, security boundaries erode, and bugs accumulate silently.

Guardian solves this by making the spec the source of truth — and checking everything against it automatically.

---

## Four Pillars

### 1. Contract Diff
_Does the code honour the spec?_

Parse `requirements.md` into `manifest.json`, then scan every `.py`, `.ts`, and `.js` file for rule violations. Returns violations with file locations and fix hints.

Rules cover: required field validation, env var guards, state transition guards, actor access boundaries, business logic conditions.

### 2. Adversarial Test Generator
_What inputs would break the spec?_

Algorithmically derives test cases directly from the manifest — no Claude API call required. Generates missing required fields, invalid enum values, bad state transitions, rule inversions, and missing env vars. Outputs a markdown test report ready to hand to Claude for verification.

### 3. Security Audit
_Who is writing what they shouldn't?_

Uses the `Actors & Access` section of the manifest to determine which actors are permitted to write each entity. Scans HTTP route handlers for write operations that lack auth/role checks. Flags violations with location, blocked actors, and fix hint.

### 4. Scale Monitor
_Is the live system healthy?_

Connects to a SQLite database and evaluates health checks derived directly from the manifest: entity state distribution, computed property values, FK integrity, and record volumes. Flags PENDING backlogs, elevated failure rates, and orphaned records.

---

## Live Hook

Guardian installs a `PostToolUse` hook into Claude Code. After every file edit Claude makes, it automatically re-runs `contract-diff` on the changed file. If violations are found, they appear as feedback in Claude's current turn — so Claude fixes them immediately rather than accumulating debt.

```
Guardian: 2 rule violation(s) in processor.py
  RULE_05 [MEDIUM]:45 — API Key Required for Analysis
    Fix: check that ANTHROPIC_API_KEY is set before executing the operation
  RULE_01 [HIGH]:102 — Content Must Be Non-Empty
    Fix: validate raw_content is non-empty before calling analyze()
```

---

## Installation

**Requirements:** Node.js 18+, Claude Code CLI

```bash
git clone https://github.com/ashzade/guardian
cd guardian && ./setup.sh
```

`setup.sh` installs dependencies and prints the exact config snippets for your machine. You'll get two things to add to your project:

**`.mcp.json`** (project root) — registers Guardian as an MCP server in Claude Code:
```json
{
  "mcpServers": {
    "guardian": {
      "command": "node",
      "args": [
        "/path/to/guardian/node_modules/.bin/ts-node",
        "--transpile-only",
        "/path/to/guardian/mcp-server.ts"
      ]
    }
  }
}
```

**`.claude/settings.json`** (project root) — enables the live hook:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/guardian/node_modules/.bin/ts-node --transpile-only /path/to/guardian/guardian-hook.ts"
          }
        ]
      }
    ]
  }
}
```

`setup.sh` fills in the correct absolute paths for your machine automatically.

Restart Claude Code after adding these files.

---

## Usage

### Start from scratch
```
Tell Claude: "run compile-spec for this project"
```
Guardian parses `requirements.md` and writes `manifest.json`. From here, every edit is checked automatically.

### Start from existing code
```
Tell Claude: "run generate-spec for this project"
```
Guardian analyses your codebase and generates a `requirements.md` using Claude. Requires `ANTHROPIC_API_KEY` in your environment.

### MCP Tools

| Tool | What it does |
|---|---|
| `compile-spec` | Parse `requirements.md` → `manifest.json` |
| `check-integrity` | Verify manifest is in sync with requirements |
| `contract-diff` | Check code against all rules in the manifest |
| `security-audit` | Find unguarded writes to restricted entities |
| `generate-tests` | Generate adversarial test cases from the manifest |
| `scale-monitor` | Query live SQLite DB for health checks |
| `generate-spec` | Analyse codebase and write `requirements.md` using Claude |
| `spec-drift` | Compare two manifests and get a refactor checklist |

All tools accept `project_root` for zero-config auto-discovery of `requirements.md`, `manifest.json`, and code files.

---

## Requirements Format

Guardian reads a structured `requirements.md`. You can write it by hand or generate it with `generate-spec`.

```markdown
---
feature_id: my_feature
version: 1.0.0
status: draft
owner: your-name
---

# My Feature

## External State Providers
...

## State Machine
...

## Actors & Access
...

## Data Model
...

## Logic Rules

#### RULE_01: Content Must Be Non-Empty
Type: Validation
Entity: Document
Condition: entity.raw_content != '' AND entity.raw_content != 'null'
Message: No content extracted; skipping analysis.
```

See `tests/fixtures/` for complete examples.

---

## Supported Languages

- Python (Flask routes, SQLAlchemy, raw sqlite3)
- TypeScript / JavaScript (Express, Knex, raw queries)
