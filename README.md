# UpToCode

**The Building Inspector for your AI-generated code.**

Vibe coding with Claude is fast—unbelievably fast. But there is a **Verification Gap** between the "sketch" the AI draws and the "building" you actually need to inhabit. Most AI tools are like fast-talking interns: they’re great at starting tasks, but they don't know your rules, your safety boundaries, or what "done" actually looks like.

**UpToCode** is your project's **Building Inspector**. It doesn't just write code; it enforces a **Product Constitution**. It interviews you to understand your blueprints, turns those "vibes" into a computable contract, and ensures that every line of code the AI writes is safe, secure, and structurally sound before a single customer walks through the door.

It’s the difference between a project that looks good and a product that is **UpToCode**.

---

## 🧠 Zero-Friction: Always on, Always Watching

You don't have to change how you work or remember to "run" a separate process; UpToCode is a silent supervisor working in the background. Once your blueprints are set, the tool runs automatically during every Claude session to catch mistakes before they become expensive repairs.

* **No Extra Commands**: Build naturally with Claude while UpToCode monitors every file edit without you having to ask.
* **Real-Time Guardrails**: UpToCode monitors your changes in real-time as you save or stage your code.
* **Catch Flaws Early**: Structural weaknesses are flagged instantly, ensuring your project is product-ready before it ever reaches a user.
* **Product Maturity by Default**: Your code stays honest and compliant through every turn, moving you from a "vibe" to a hardened product with zero extra effort.

---

## 🏗️ What it does

### 1. The Inspector's Clipboard (Logic Enforcement)
UpToCode turns your plain-English instructions into a formal **Predicate Grammar**. Every time the AI edits a file, UpToCode runs a deterministic check to ensure the logic matches your blueprints.
> *"Your blueprints say a user must pay before seeing this page. This code skips that check."*

### 2. The Stress Test (Adversarial Probing)
UpToCode uses your **State Machine** to find the hidden ways your app could break. It generates "adversarial personas" that try to bypass your logic to ensure your walls don't crumble under pressure.
> *"What if someone clicks 'Submit' twice? What if they try to access the dashboard while their account is suspended?"*

### 3. Zoning & Permits (Security Auditing)
You define exactly who is allowed to touch what data. UpToCode scans for security violations and flags any code that tries to cross a boundary it shouldn't.
> *"CRITICAL: This dashboard route is writing to a table only the system should touch."*

### 4. Foundation Health (Live Monitoring)
Once you ship, UpToCode monitors your live database for "architectural drift" or stuck records that signal your logic is failing in the wild.
> *"16 users have 'Active' status but missing Stripe IDs. Foundation integrity failing."*

---

## 🔄 The Vibe-to-Product Workflow

UpToCode uses a **Two-Surface Architecture** to stay with you from the first prompt to the final building permit.

| Step | Action | Tool Role | Interface |
| :--- | :--- | :--- | :--- |
| **1. Ideate** | "I want a pro tier." | **Architect:** Asks about logic & permissions. | IDE Sidebar |
| **2. Formalize** | User clicks "Approve." | **Contractor:** Writes your `requirements.md`. | IDE Sidebar |
| **3. Code** | AI generates code. | **Supervisor:** Monitors diffs in real-time. | IDE Sidebar |
| **4. Verify** | Push to GitHub. | **Inspector:** Runs the "Candidate Truth" check. | GitHub PR |
| **5. Harden** | Click "Apply Fix." | **Enforcer:** Refactors code to satisfy the spec. | GitHub PR |

**"Vibe writes it. UpToCode proves it."**

---

## 🚀 Getting Started

### Step 0: The Cold Start (Grounding your project)
If you already have code, UpToCode analyzes your existing files and **reverse-engineers** a starter blueprint for you.
> *"Run generate-spec for this project"*

### Step 1: The Interview
If you're starting from scratch, open Claude Code and say:
> *"Interview me to build my spec"*

UpToCode asks plain-English questions to fill your **States, Entities, and Rules**. Once the progress bar hits 100%, your "Product Memory" is locked in.

---

## 💻 Commands

| What you say | What happens |
| :--- | :--- |
| *"Interview me to build my spec"* | Builds your `requirements.md` via plain-English Q&A. |
| *"Run vibe compile"* | Turns your Markdown into a machine-readable `manifest.json`. |
| *"Run contract-diff"* | Proves your code matches the "Candidate Truth" of your spec. |
| *"Run generate-tests"* | Stress-tests your app with adversarial logic cases. |
| *"Run security-audit"* | Plugs holes in your "Zoning & Permits". |

---

## Installation

**Requirements:** [Node.js](https://nodejs.org) (v18+) and [Claude Code](https://claude.ai/code).

```bash
git clone [https://github.com/ashzade/uptocode](https://github.com/ashzade/uptocode)
cd uptocode && ./setup.sh
