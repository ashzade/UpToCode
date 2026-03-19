# Walkthrough: Building a Waitlist App with Guardian

This is a complete worked example. You'll build a simple waitlist app — people sign up, an admin invites them — and see Guardian catch real bugs as Claude writes the code.

**What you'll see:**
- Writing `requirements.md` in plain English
- Guardian turning it into enforceable rules
- Claude writing code that breaks a rule
- Guardian catching it in the same turn, before it becomes a bug
- The fix

---

## The project

A waitlist app. People submit their email and join a queue. An admin reviews the list and sends invites. Simple.

Three things that could go wrong if Claude codes carelessly:
1. Sending an invite without an API key configured → crash in production
2. A public endpoint that can send invites directly → anyone can invite anyone
3. An email field that accepts empty strings → garbage data in your database

Guardian will catch all three.

---

## Step 1: Write requirements.md

Create a file called `requirements.md` in your project root. You're describing what the app does, not how to build it. Write it like you'd explain it to a new teammate.

```markdown
---
feature_id: waitlist
version: 1.0.0
status: draft
owner: your-name
depends_on:
  - email_api
tags:
  - waitlist
  - onboarding
---

# Waitlist

Accepts email signups and queues them for review. An admin can invite
or reject signups. Invitations are sent via an external email API.

## External State Providers

### EmailAPI
source: email-api
provides: sends invitation emails to waitlist signups
lookup_key: signup_id
Methods:
  - send_invite(email: string, name: string): boolean

## State Machine

### States

- PENDING – signup received, not yet reviewed
- INVITED – admin sent an invitation
- REJECTED – admin rejected the signup

### Transitions

#### PENDING → INVITED
Trigger: admin sends invitation
Guard: RULE_01
Action: emit_event(INVITE_SENT), set_field(entity.status, 'invited'), set_field(entity.invited_at, NOW())

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
RULE_02: HIGH → reject
RULE_03: MEDIUM → reject

## Data Model

### Signup

id:          integer | primary | auto-gen
email:       string  | required | unique | indexed
name:        string  | nullable
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

#### RULE_02: Email API Key Required
Type: Business
Entity: Signup
Condition: env(EMAIL_API_KEY) != '' AND entity.status == 'pending'
Message: Email API key not configured — cannot send invitations.

### Business Rules

#### RULE_03: Only Pending Signups Can Be Invited
Type: Business
Entity: Signup
Condition: entity.status == 'pending'
Message: Cannot invite a signup that is not in pending status.
```

---

## Step 2: Compile the spec

Open Claude Code in your project folder and say:

> *"Run compile-spec for this project"*

Guardian reads your `requirements.md` and writes a `manifest.json` next to it. This is the machine-readable version of your spec — the ruleset Guardian enforces from this point on.

You'll see something like:

```
✓ manifest.json written
```

You don't need to look at `manifest.json`. It's for Guardian, not for you.

---

## Step 3: Ask Claude to build the app

Say something like:

> *"Build a Flask API for this waitlist app. I need endpoints to submit an email, list all signups, and send an invite."*

Claude writes the code. Here's a simplified version of what it might produce for the invite endpoint:

```python
@app.route("/api/signups/<int:signup_id>/invite", methods=["POST"])
def send_invite(signup_id):
    signup = db.get_signup(signup_id)
    if not signup:
        abort(404)

    # Send the invite
    email_client.send_invite(signup["email"], signup["name"])
    db.update_status(signup_id, "invited")
    return jsonify({"ok": True})
```

Looks reasonable. But Guardian sees three problems.

---

## Step 4: Guardian catches the bugs

The moment Claude writes that file, the live hook fires. Claude sees this feedback immediately:

```
Guardian: 2 rule violation(s) in app.py

  RULE_02 [HIGH]:8 — Email API Key Required
    Fix: check that EMAIL_API_KEY is set before executing the operation.
    Python: if not os.getenv('EMAIL_API_KEY'): raise/return

  RULE_03 [MEDIUM]:8 — Only Pending Signups Can Be Invited
    Fix: add a guard to check entity.status == 'pending' before proceeding
```

Claude doesn't move on. It fixes both issues in the same turn:

```python
@app.route("/api/signups/<int:signup_id>/invite", methods=["POST"])
def send_invite(signup_id):
    if not os.getenv("EMAIL_API_KEY"):
        abort(500, "Email API key not configured")

    signup = db.get_signup(signup_id)
    if not signup:
        abort(404)

    if signup["status"] != "pending":
        abort(400, "Cannot invite a signup that is not in pending status")

    email_client.send_invite(signup["email"], signup["name"])
    db.update_status(signup_id, "invited")
    return jsonify({"ok": True})
```

Guardian runs again. No violations. Claude moves on.

---

## Step 5: Generate the test suite

Once the app is built, say:

> *"Run generate-tests for this project"*

Guardian reads your spec and produces `adversarial-tests.md` — a list of inputs designed to break the app:

```
T01: Signup.email missing                [HIGH]   Submit with no email field
T02: Signup.email empty string           [MEDIUM] Submit with email = ""
T03: Signup.status invalid enum          [HIGH]   Set status to "approved"
T04: PENDING → INVITED without RULE_01  [HIGH]   Invite with empty email
T05: PENDING → REJECTED → INVITED       [HIGH]   Invalid state transition
T06: Missing EMAIL_API_KEY              [HIGH]   Call invite with no env var set
```

Hand this to Claude:

> *"Go through each test in adversarial-tests.md and verify the code handles it. Fix anything that doesn't."*

---

## Step 6: Run the security audit

> *"Run security-audit for this project"*

Guardian checks whether the `PublicAPI` routes can reach data they shouldn't. In this example, if you accidentally added a `/invite` endpoint to the public router instead of the admin router, Guardian would catch it:

```
S01 [HIGH]: Unguarded write to Signup in public_routes.py:34
  Write actors: AdminAPI
  Blocked actors: PublicAPI
  Fix: Move this endpoint to the admin router or add an admin check.
```

---

## What just happened

You wrote a plain-English description of your app. Guardian turned it into a set of rules that Claude had to follow while coding. Bugs that would typically reach code review — or worse, production — were caught in the same edit that introduced them.

The app you end up with matches what you designed. Not approximately. Exactly.

---

## Try it yourself

1. Clone the repo and run `./setup.sh`
2. Create a new project folder
3. Write a `requirements.md` describing what you're building (use the example above as a template)
4. Open Claude Code in that folder and say: *"Run compile-spec for this project"*
5. Start building

If you already have an existing project, skip straight to:

> *"Run generate-spec for this project"*

Guardian will read your code and write the spec for you.
