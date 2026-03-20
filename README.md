# UpToCode

**The Building Inspector for your AI-generated code.**

Vibe coding with Claude is fast—unbelievably fast. But there is a **Verification Gap** between the "sketch" the AI draws and the "building" you actually need to inhabit. Most AI tools are like fast-talking interns: they’re great at starting tasks, but they don't always know where the safety boundaries are, and often, you might not know them either. 

**UpToCode** is your project's **Building Inspector**. It doesn't just write code; it helps you figure out the rules you didn't even know you needed. It interviews you to turn your ideas into a **Master Playbook**, creates an **Automated Safety Net**, and ensures that every line of code the AI writes is safe, secure, and structurally sound before a single customer walks through the door.

It’s the difference between a project that looks good and a product that is **UpToCode**.

---

## 🧠 Zero-Friction: You Focus on the Idea, We Handle the Engineering

You don't need to be a senior engineer or know the "right" professional processes to ship a great product. UpToCode is a silent supervisor working in the background that handles the technical heavy lifting for you.

* **No Expert Knowledge Needed**: You don't have to know how to set up testing or security—UpToCode helps you fill in those gaps as you go.
* **Invisible Supervision**: There is no separate process to remember or "run"; UpToCode works automatically inside your Claude sessions to catch mistakes before they become expensive repairs.
* **Real-Time Guardrails**: UpToCode watches your changes in real-time as you save or stage your code, making sure everything stays on track.
* **Product-Ready by Default**: Your code stays honest and professional through every turn, moving you from a "vibe" to a hardened product with zero extra effort.

---

## 🏗️ What it does

### 1. The Inspector's Clipboard (Logic Enforcement)
UpToCode turns your plain-English instructions into a **Smart Logic Engine**. Every time the AI edits a file, UpToCode checks the code to make sure it actually follows your instructions.
> *"Your playbook says a user must pay before seeing this page. This code skips that check."*

### 2. The Stress Test (Adversarial Probing)
UpToCode maps out every path a user can take to find the cracks where things usually break. It dreams up "what if" scenarios to make sure your app doesn't crumble when a user does something unexpected.
> *"What if someone clicks 'Submit' twice? What if they try to access the dashboard while their account is suspended?"*

### 3. Zoning & Permits (Security Auditing)
You define exactly who is allowed to touch what data. UpToCode scans for security violations and flags any code that tries to cross a boundary it shouldn't.
> *"CRITICAL: This dashboard route is writing to a table only the system should touch."*

### 4. Foundation Health (Live Monitoring)
Once you ship, UpToCode monitors your live database for technical "drift" or stuck records that signal your logic is failing in the real world.
> *"16 users are 'Active' status but missing Stripe IDs. The foundation is failing."*

---

## 🔄 The Vibe-to-Product Workflow

UpToCode stays with you from the first prompt to the final building permit.

| Step | Action | Tool Role | Interface |
| :--- | :--- | :--- | :--- |
| **1. Ideate** | "I want a pro tier." | **Architect:** Asks questions to fill in the gaps. | IDE Sidebar |
| **2. Formalize** | User clicks "Approve." | **Contractor:** Writes your `requirements.md`. | IDE Sidebar |
| **3. Code** | AI generates code. | **Supervisor:** Monitors diffs in real-time. | IDE Sidebar |
| **4. Verify** | Push to GitHub. | **Inspector:** Checks the code against your Playbook. | GitHub PR |
| **5. Harden** | Click "Apply Fix." | **Enforcer:** Refactors code to satisfy the spec. | GitHub PR |

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

---

## 💻 Commands

| What you say | What happens |
| :--- | :--- |
| *"Interview me to build my spec"* | Builds your `requirements.md` by helping you think through the rules. |
| *"Run vibe compile"* | Turns your Markdown into a machine-readable safety net. |
| *"Run contract-diff"* | Makes sure your code actually follows your Playbook. |
| *"Run generate-tests"* | Finds the hidden ways your app could break. |
| *"Run security-audit"* | Plugs holes in your "Zoning & Permits." |

---

## Installation

**Requirements:** [Node.js](https://nodejs.org) (v18+) and [Claude Code](https://claude.ai/code).

```bash
git clone [https://github.com/ashzade/uptocode](https://github.com/ashzade/uptocode)
cd uptocode && ./setup.sh
