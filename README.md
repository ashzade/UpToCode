# UpToCode

**The code inspector for AI-built apps.**

When you build with Claude, code goes up fast. Really fast. It's like a construction project with no foreman — walls go up without anyone checking the load-bearing requirements, wiring gets run before anyone confirms the safety standards, and by the time you're done it looks like a building. Whether it'll hold is a different question.

UpToCode is the inspector. You describe what you're building in plain English — through a conversation, no technical knowledge required. UpToCode writes it all down as a spec, turns it into a set of rules, and checks every file Claude touches against those rules. Anything that doesn't match what you said you wanted gets flagged immediately, in the same turn, before it becomes a problem you find in production.

Every new Claude session starts with amnesia. The spec is what you hand it instead of re-explaining everything from scratch. It's your product memory — what you're building, who can do what, what rules must hold, what states things move through.

The difference between vibe coding a project and shipping a product that's actually up to code.

---

## What it does

UpToCode sits next to you while Claude builds. Four jobs:

### 1. Checks the code matches your plan
You describe your feature in a conversation. UpToCode turns it into a set of rules. Every time Claude edits a file, UpToCode checks those rules and tells Claude immediately if something's wrong — before the mistake becomes a bug.

> *"You said the API key must be set before calling the email service. This code skips that check."*

### 2. Tries to break your app before your users do
UpToCode reads your plan and generates a list of adversarial test cases — wrong inputs, missing fields, invalid sequences of events. It hands these to Claude with the question: does the code handle all of these correctly? Most vibe-coded apps don't. Now yours will.

> *"What happens if someone submits a form with no email? What if they call this endpoint twice?"*

### 3. Spots security holes in who can access what
You describe who is allowed to do what in your app. UpToCode scans the code and flags anywhere that a part of the app is touching data it shouldn't be allowed to touch.

> *"Your dashboard API is writing directly to a table that only the background processor should write to."*

### 4. Checks your database is healthy
Once your app is running, UpToCode connects to your database and checks whether everything looks right — are records stuck in a queue? Are there items pointing to things that no longer exist? Is anything failing at an unusual rate?

> *"16 tasks reference documents that don't exist. 0 documents are stuck in pending."*

---

## How it fits into your workflow

```
UpToCode interviews you           →  Asks plain-English questions about what you're building
UpToCode writes the spec          →  Your product memory — rules, data, states, actors, all in one place
New Claude session?               →  Hand it the spec — no re-explaining, no context lost
You vibe code with Claude         →  Claude writes the code fast
UpToCode watches every edit       →  Flags anything that breaks the rules instantly
Claude fixes it in the same turn  →  The code stays up to code as you go
```

By the time you're ready to ship, you have:
- A single document that describes your product completely
- Code that matches what you designed
- A test suite that tries to break it
- Confirmation that your security boundaries hold
- A live health check on your database

That's what separates a project from a product.

---

## See it in action

**→ [Full walkthrough: building a waitlist app with UpToCode](docs/walkthrough.md)**

Covers the full journey — UpToCode interviewing you, building the spec, Claude writing code with bugs, UpToCode catching them in real time, and generating the test suite. Takes about 5 minutes to read.

---

## Installation

**You need:** [Node.js](https://nodejs.org) (v18 or later) and [Claude Code](https://claude.ai/code).

```bash
git clone https://github.com/ashzade/uptocode
cd uptocode && ./setup.sh
```

The setup script installs everything and prints two small config snippets to copy into your project. One tells Claude Code that UpToCode exists. The other turns on the live hook so UpToCode runs on every edit automatically.

After that, restart Claude Code in your project.

---

## Getting started

### Step 1: Create your spec

**Starting from scratch — no code yet:**

Open Claude Code in your project folder and say:

> *"Interview me to build my spec"*

UpToCode asks you plain-English questions about what you're building — what it does, who uses it, what rules it must follow. You answer in your own words. No technical knowledge required. When you're done, it writes the spec and activates enforcement automatically.

If you already have a spec and want to update it:

> *"Interview me to build my spec"*

UpToCode detects the existing spec, compiles it, and offers to update it or start building straight away.

**Already have code:**

> *"Run generate-spec for this project"*

UpToCode analyses your existing code and writes the spec for you. Requires `ANTHROPIC_API_KEY` in your environment.

### Step 2: Start building

Once your spec is in place, just build normally with Claude. UpToCode watches every file edit and flags violations in real time — no extra commands needed.

---

## What you can ask UpToCode to do

Once installed, just ask Claude naturally:

| What you say | What happens |
|---|---|
| *"Interview me to build my spec"* | UpToCode asks you questions and builds requirements.md from your answers |
| *"Run compile-spec for this project"* | Activates enforcement from your requirements.md |
| *"Run contract-diff for this project"* | Checks all your code against the rules right now |
| *"Run generate-tests for this project"* | Generates a list of ways to break your app |
| *"Run security-audit for this project"* | Finds data access that shouldn't be there |
| *"Run scale-monitor for this project"* | Checks your live database for problems |
| *"Run generate-spec for this project"* | Reads existing code and writes requirements.md for you |

---

## Supported languages

Python, TypeScript, JavaScript.

Works with Flask, Express, FastAPI, SQLAlchemy, Knex, and raw SQL queries.
