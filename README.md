# Guardian

**Your AI co-worker that makes sure the code actually matches what you designed.**

When you build with Claude, code gets written fast. Really fast. But fast code isn't always *correct* code — Claude doesn't know your rules, your data boundaries, or what you actually meant when you described the feature. It just codes.

Guardian fixes that. You write down what you're building in plain English. Guardian reads it, understands it, and then watches every file Claude touches — flagging anything that doesn't match what you said you wanted.

It's the difference between vibe coding a project and shipping a product.

---

## What it does

Think of Guardian as a technical co-worker sitting next to you while you build. It does four jobs:

### 1. Checks the code matches your plan
You describe your feature in a document called `requirements.md`. Guardian reads it and turns it into a set of rules. Every time Claude edits a file, Guardian checks those rules and tells Claude immediately if something's wrong — before the mistake becomes a bug.

> *"You said the API key must be set before calling Claude. This code skips that check."*

### 2. Tries to break your app before your users do
Guardian reads your plan and generates a list of adversarial test cases — wrong inputs, missing fields, invalid sequences of events. It hands these to Claude with the question: does the code handle all of these correctly? Most vibe-coded apps don't. Now yours will.

> *"What happens if someone submits a form with no email? What if they call this endpoint twice?"*

### 3. Spots security holes in who can access what
You describe who is allowed to do what in your app. Guardian scans the code and flags anywhere that a part of the app is touching data it shouldn't be allowed to touch.

> *"Your dashboard API is writing directly to a table that only the background processor should write to."*

### 4. Checks your database is healthy
Once your app is running, Guardian connects to your database and checks whether everything looks right — are documents stuck in a processing queue? Are there records pointing to things that no longer exist? Is anything failing at an unusual rate?

> *"16 tasks reference documents that don't exist. 0 documents are stuck in pending."*

---

## How it fits into your workflow

```
You write requirements.md        →  Describe what you're building in plain English
Guardian reads it                →  Turns it into a set of enforceable rules
You vibe code with Claude        →  Claude writes the code fast
Guardian watches every edit      →  Flags anything that breaks the rules instantly
Claude fixes it in the same turn →  The code stays honest as you go
```

By the time you're ready to ship, you have:
- Code that matches what you designed
- A test suite that tries to break it
- Confirmation that your security boundaries hold
- A live health check on your database

That's what separates a project from a product.

---

## Installation

**You need:** [Node.js](https://nodejs.org) (v18 or later) and [Claude Code](https://claude.ai/code).

```bash
git clone https://github.com/ashzade/guardian
cd guardian && ./setup.sh
```

The setup script installs everything and prints two small config files to copy into your project. One tells Claude Code that Guardian exists. The other turns on the live hook so Guardian runs on every edit automatically.

After that, restart Claude Code in your project.

---

## Getting started

**If you're starting a new project:**

Open Claude Code in your project folder and say:

> *"Write a requirements.md for this project"*

Then once it's written:

> *"Run compile-spec for this project"*

Guardian reads your requirements and from that point on, watches every edit Claude makes.

**If you already have code:**

> *"Run generate-spec for this project"*

Guardian analyses your existing code and writes a `requirements.md` for you automatically. Requires `ANTHROPIC_API_KEY` set in your environment.

---

## What you can ask Guardian to do

Once installed, just ask Claude naturally:

| What you say | What happens |
|---|---|
| *"Run compile-spec for this project"* | Turns your requirements.md into an enforceable ruleset |
| *"Run contract-diff for this project"* | Checks all your code against the rules right now |
| *"Run generate-tests for this project"* | Generates a list of ways to break your app |
| *"Run security-audit for this project"* | Finds data access that shouldn't be there |
| *"Run scale-monitor for this project"* | Checks your live database for problems |
| *"Run generate-spec for this project"* | Reads your code and writes requirements.md for you |

---

## Supported languages

Python, TypeScript, JavaScript.

Works with Flask, Express, FastAPI, SQLAlchemy, Knex, and raw SQL queries.
