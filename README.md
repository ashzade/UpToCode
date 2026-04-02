# UpToCode

**The Building Inspector for your AI-generated code.**

Vibe coding with Claude is fast—unbelievably fast. But there is a **Verification Gap** between the "sketch" the AI draws and the "building" you actually need to inhabit. Most AI tools are like fast-talking interns: they're great at starting tasks, but they don't always know where the safety boundaries are, and often, you might not know them either.

**UpToCode** is your project's **Building Inspector**. It doesn't just check the code — it runs the entire engineering operation alongside you. It interviews you to turn your ideas into a **Master Playbook**, enforces every rule as Claude builds, sets up your GitHub repository, manages your commit history, and posts inspection reports on every pull request.

You don't need to know what any of that means. UpToCode handles the engineering discipline. You handle the idea.

The spec you build through that conversation becomes the single source of truth for your entire project — it drives the code enforcement, the test suite, the security checks, and the README that appears on your GitHub repository. Change the spec, and UpToCode updates everything downstream.

It's the difference between a project that looks good and a product that is **UpToCode**.

---

## 🧠 Zero-Friction: You Focus on the Idea, We Handle the Engineering

You don't need to be a senior engineer or know the "right" professional processes to ship a great product. UpToCode is a silent supervisor working in the background that handles the technical heavy lifting for you.

* **No Expert Knowledge Needed**: You don't need to know how to set up version control, testing, or security reviews — UpToCode handles all of it and teaches you what it's doing along the way.
* **Invisible Supervision**: There is no separate process to remember or "run"; UpToCode works automatically inside your Claude sessions to catch mistakes before they become expensive repairs.
* **Conflict Detection Before You Build**: When you describe a new feature, UpToCode checks whether your request conflicts with your existing rules before Claude writes a single line. If it does, you're told immediately — so you decide upfront, not after the code is already written.
* **Contradiction-Free Specs**: When you update your spec, UpToCode checks whether any rules contradict each other before saving it. If two rules can never both be true at the same time, the spec is blocked and you're shown exactly which rules conflict and how to resolve them.
* **Real-Time Guardrails**: UpToCode watches your changes in real-time as you save or stage your code, making sure everything stays on track — including TypeScript type errors, new external services that aren't in your spec, dead code left behind after a refactor, and missing files that were imported but never created.
* **Session-Start Auto-Fix**: At the start of every session, UpToCode scans the full codebase and automatically fixes any HIGH/CRITICAL violations before Claude responds to you. Catches and resolves drift from work done outside Claude — direct edits, migrations, or other tools — without you having to ask.
* **CI Failure Alerts**: UpToCode checks your GitHub Actions status at the start of every session. If a build failed since you last worked — overnight CI run, a push from another machine, a nightly adversarial test — you're told before Claude responds to anything. No more opening GitHub to find out something broke hours ago.
* **Pre-Push Auto-Fix**: Before committing and pushing any code to GitHub, UpToCode runs a full inspection. If violations remain, Claude fixes them first — then pushes. Your GitHub history is always clean.
* **Adversarial Test Auto-Fix**: When adversarial tests are generated, UpToCode immediately evaluates them against the live codebase and surfaces any failures in the same response. Claude fixes missing guards in the same turn — no follow-up prompt needed.
* **Session Reports**: At the end of each response, UpToCode prints a plain-English summary of what it caught and fixed.
* **GitHub Setup & Workflow**: UpToCode sets up your GitHub repository, handles your commit history, and introduces professional practices like pull requests — automatically, without you having to ask.
* **Automatic PRs & Auto-Merge**: Every session creates a pull request. When the inspection passes, it merges automatically. When it doesn't, you're told immediately — right in your terminal.
* **Product-Ready by Default**: Your code stays honest and professional through every turn, moving you from a "vibe" to a hardened product with zero extra effort.

---

## 🏗️ What it does

### 1. The Inspector's Clipboard (Logic Enforcement)
UpToCode turns your plain-English instructions into a **Smart Logic Engine**. Enforcement happens at every stage — before you build, while you build, and before your code reaches GitHub.

**Before you build** — when you describe a new feature, UpToCode checks whether it conflicts with your existing rules. If your spec says "payment required before access" and you ask to "let users in for free," UpToCode flags it before Claude writes anything.
> *"UpToCode: this request conflicts with RULE_03 — 'Payment required before dashboard access'. Implementing free access would violate this rule. Tell the user to update their spec first if this is intentional."*

**When you update your spec** — UpToCode checks whether any rules contradict each other before saving. Two rules that can never both be true block the save entirely.
> *"❌ RULE_03 ↔ RULE_07 [CRITICAL] — RULE_03 requires is_paid == true, but RULE_07 requires is_paid == false. Both cannot be true at the same time. manifest.json was not written."*

**While you build** — every file edit is checked against the full rule set in real time.
> *"Your playbook says a user must pay before seeing this page. This code skips that check."*
> *"TypeScript error in route.ts — 'details_verified' does not exist in type. Fix before deploying."*
> *"New external provider detected — '@foursquare/api' is not in your spec. Say 'Update my spec to reflect this change' to sync it."*
> *"'GooglePlaces' is declared in your spec but not imported anywhere. Say 'Clean up removed providers from my spec' to remove it."*
> *"2 missing imports in checkout/route.ts — these files don't exist yet: ./lib/payments, ./hooks/useCart. Create the missing file(s) before finishing."*

### 2. The Stress Test (Adversarial Probing)
UpToCode maps out every path a user can take to find the cracks where things usually break. It dreams up "what if" scenarios to make sure your app doesn't crumble when a user does something unexpected. Then it immediately checks whether those scenarios are actually guarded against — and fixes any that aren't, in the same turn.
> *"What if someone clicks 'Submit' twice? What if they try to access the dashboard while their account is suspended?"*
> *"⚠️ 12/47 adversarial tests FAIL. Field 'email' has no required-check guard. State machine has no assertValidTransition call. Fixing now…"*

### 3. Zoning & Permits (Security Auditing)
You define exactly who is allowed to touch what data. UpToCode scans for security violations and flags any code that tries to cross a boundary it shouldn't.
> *"CRITICAL: This dashboard route is writing to a table only the system should touch."*

### 4. Foundation Health (Live Monitoring)
Once you ship, UpToCode monitors your live database for technical "drift" or stuck records that signal your logic is failing in the real world. Works with both SQLite and Postgres — for Postgres projects, it reads your `DATABASE_URL` automatically.
> *"16 users are 'Active' status but missing Stripe IDs. The foundation is failing."*

### 5. Coherence Scan (AI Drift Detection)
AI sessions are fast — but each session doesn't know what the last one did. Over time, your codebase accumulates structural issues that no single session catches: dead exports that were refactored away, validation errors silently swallowed by empty catch blocks, the same error message string copy-pasted into six files, or a TypeScript interface that says a field is optional while the validator throws if it's missing.

The Coherence Scan is the sixth pillar — a dedicated pass specifically for catching the structural decay that multi-session AI coding creates.

> *"3 HIGH issues found — silent catch at route.ts:47 voids the validatePayment contract. 2 TypeScript mismatches: userId? in CreateOrderInput is required at runtime. 1 env var read at module scope will be undefined in serverless cold starts."*

**Six detectors run on every coherence scan:**

| Detector | What it catches | Severity |
| :--- | :--- | :--- |
| **Dead Exports** | Functions/classes exported but never imported anywhere | MEDIUM |
| **Dead Files** | TypeScript files that no other file imports (excluding entry points) | LOW |
| **Silent Catches** | try/catch blocks that swallow `validateXxx()` errors with no rethrow or error response | HIGH |
| **Env Scope** | `process.env.VAR` read at module top-level instead of inside functions (breaks serverless & tests) | MEDIUM |
| **Duplicate Logic** | String literals >30 chars appearing 3+ times; function bodies with identical call sequences | LOW/MEDIUM |
| **TS Contract Mismatch** | Interface field is `field?: type` (optional) but the runtime validator throws if it's absent | HIGH |
| **API Envelope** | Sibling routes for the same resource return different JSON shapes | LOW |

Run it any time:
> *"Run coherence-scan for this project"*

---

## 🔄 The Vibe-to-Product Workflow

UpToCode stays with you from the first prompt to the final building permit.

| Step | Action | Tool Role | Interface |
| :--- | :--- | :--- | :--- |
| **1. Ideate** | "I want a pro tier." | **Architect:** Asks questions to fill in the gaps. | IDE Sidebar |
| **2. Formalize** | User clicks "Approve." | **Contractor:** Writes your `requirements.md` — checks for contradictions before saving. | IDE Sidebar |
| **3. Build** | "Add this feature." | **Gatekeeper:** Checks your request against existing rules before writing any code. | IDE Sidebar |
| **4. Code** | AI generates code. | **Supervisor:** Monitors diffs in real-time. | IDE Sidebar |
| **5. Verify** | Push to GitHub. | **Inspector:** Checks for violations — fixes any it finds, then pushes. | Terminal |
| **6. Review** | PR opens automatically. | **Enforcer:** CI inspection report posted as PR comment. | GitHub PR |

**"Vibe writes it. UpToCode makes it product-ready."**

---

## 🚀 Getting Started

### Step 0: The Cold Start (Grounding your project)
If you already have code, UpToCode analyzes your existing files and **reverse-engineers** a starter blueprint for you.
> *"Run generate-spec for this project"*

### Step 1: The Interview
If you're starting from scratch, open Claude Code and say:
> *"Interview me to build my spec"*

UpToCode asks plain-English questions to fill in three key areas:
* **Entities**: The "Things" in your app (like Users, Orders, or Posts).
* **States**: The "Lifecycle" of those things (e.g., a post moving from Draft → Published → Deleted).
* **Rules**: The "Guardrails" that keep things safe (e.g., "Only the owner can delete this post").

The result is a `requirements.md` file that works on two levels at once. Each rule, transition, and entity has a plain-English description you can read and understand — and the structured definition beneath it that UpToCode enforces. You never need to learn any syntax. If something looks wrong, you can read it, and say *"Update rule X to reflect Y"* and UpToCode will fix it.

```
#### RULE_05: API Keys Required for Enrichment
> Google Places API key must be configured; cannot enrich restaurant details.

Type: Business
Condition: env(GOOGLE_PLACES_API_KEY) != ''
```

---

## 💻 Commands

| What you say | What happens |
| :--- | :--- |
| *"Interview me to build my spec"* | Builds your `requirements.md` by helping you think through the rules. |
| *"Help me set up GitHub for this project"* | Creates your repo, generates a README, pushes your code, sets up the inspection workflow, and enables branch protection. |
| *"Generate a README for my project"* | Writes a plain-English README.md from your spec. |
| *"Run compile-spec for this project"* | Turns your `requirements.md` into a machine-readable safety net, and adds plain-English descriptions so you can read it too. |
| *"Run contract-diff for this project"* | Makes sure your code actually follows your Playbook. |
| *"Run generate-tests for this project"* | Finds the hidden ways your app could break — then checks whether each one is already guarded against and fixes any that aren't. |
| *"Run security-audit for this project"* | Plugs holes in your "Zoning & Permits." |
| *"Run scale-monitor for this project"* | Checks your live database for architectural drift. |
| *"Run coherence-scan for this project"* | Finds AI-drift issues: dead code, silent catches, env scope bugs, TS contract mismatches, duplicates, and API envelope inconsistencies. |
| *"Run generate-spec for this project"* | Reverse-engineers a starter Playbook from existing code. |
| *"Show me my UpToCode report"* | Shows everything UpToCode has caught and fixed across all sessions — top rules triggered, most-flagged files, and resolution rate. |

### Sample Session Report

```
## UpToCode Session Report
Mar 21 → Mar 23

|                         |      |
|-------------------------|------|
| Total violations caught | 47   |
| Files flagged           | 12   |
| Files resolved          | 10   |
| Resolution rate         | 83%  |

### Most triggered rules
- RULE_05 [HIGH] — API key must be configured · 8× (8 fixed)
- RULE_01 [HIGH] — Query must include a city and search text · 6× (5 fixed)
- RULE_03 [MEDIUM] — Extracted restaurant must have a name · 5× (5 fixed)
- RULE_06 [LOW] — Default city fallback required · 4× (3 fixed)

### Most flagged files
- ✓ `app/api/search/route.ts` — 11 violations
- ✓ `lib/scrape.ts` — 9 violations
- ○ `app/api/places/route.ts` — 6 violations
- ✓ `lib/enrich.ts` — 5 violations
```

---

## 🔁 GitHub: From Zero to Professional Workflow

Most vibe coders have never touched GitHub. UpToCode sets it all up for you and runs it in the background — you just keep building.

### Setting up GitHub

After your spec is created, say:
> *"Help me set up GitHub for this project"*

UpToCode will:
1. Create a GitHub repository under your account
2. Generate a README for your project from your spec
3. Push all your code
4. Install the inspection workflow
5. Enable branch protection — PRs only merge when the inspection passes
6. Auto-save your progress to GitHub at the end of every session

No git commands. No configuration. One message.

### What happens automatically after that

**Every session:** UpToCode commits your work to a session branch (`claude/YYYY-MM-DD-HHmm`) and opens a pull request to main. Your progress is always saved and tracked.

**While you build:** When a logic check passes and you have uncommitted changes, UpToCode tells you immediately — with the exact commit command to run. You never lose a day's work to a forgotten commit.

**Every push:** A Building Inspection Report runs automatically in GitHub Actions — logic enforcement, security audit, and spec drift — and posts as a comment on the PR.

**When your spec changes:** If your PR updates `requirements.md`, UpToCode posts a living checklist comment showing exactly which spec changes are implemented vs still missing. The checklist updates itself on every push. The PR is done when every item is checked.

**When the inspection passes:** The PR merges automatically. You don't have to touch GitHub.

**When the inspection fails:** UpToCode tells you immediately in your terminal at the end of the next response — including a direct link to the blocked PR. You never have to check GitHub to know something needs fixing.

**Nightly:** Adversarial test cases are generated from your spec and immediately evaluated against the codebase. Any HIGH-severity failures fail the CI job — Claude fixes them in the next session automatically. You can also trigger this manually from the GitHub Actions tab at any time.

| Check | When | Result |
|---|---|---|
| **Logic Enforcement** | Every push | ✅ Pass / ❌ Violations block merge |
| **Security Audit** | Every push | ✅ Pass / ❌ Findings block merge |
| **Spec Drift** | Every PR | ⚠️ Living checklist of unimplemented spec changes |
| **Adversarial Tests** | Nightly + on demand | ⚠️ Cases generated & evaluated — HIGH failures block merge |
| **Database Health** | On demand | Run `scale-monitor` locally |
| **Coherence Scan** | On demand | HIGH/MEDIUM issues flagged — run `coherence-scan` locally |

### Why this matters

A commit history, pull requests, and CI checks aren't bureaucracy — they're the record of your product's evolution and the safety net that stops broken code from reaching users. Senior engineers build this way by default. UpToCode gives you the same workflow without needing to understand how any of it works.

---

## Installation

**Requirements:** [Node.js](https://nodejs.org) (v18+) and [Claude Code](https://claude.ai/code).

```bash
git clone https://github.com/ashzade/UpToCode
cd UpToCode && ./setup.sh
```
