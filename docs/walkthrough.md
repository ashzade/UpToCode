# Walkthrough: Building a Waitlist App with Guardian

This is a complete worked example. You'll build a simple waitlist app — people sign up, an admin invites them — and see Guardian catch real bugs as Claude writes the code.

**What you'll see:**
- Guardian interviewing you about what you're building
- Guardian turning your answers into an enforceable spec
- Claude writing code that breaks a rule
- Guardian catching it in the same turn, before it becomes a bug
- The fix

No technical knowledge required to follow along.

---

## The project

A waitlist app. People submit their email and join a queue. An admin reviews the list and sends invites. Simple.

Three things that could go wrong if Claude codes carelessly:
1. Sending an invite without an API key configured → crash in production
2. A public endpoint that can send invites directly → anyone can invite anyone
3. An email field that accepts empty strings → garbage data in your database

Guardian will catch all three.

---

## Step 1: Install Guardian and open your project

Follow the [installation steps](../README.md#installation), then open Claude Code in a new empty project folder.

---

## Step 2: Let Guardian interview you

Say to Claude:

> *"Interview me to build my spec"*

Guardian starts asking you questions one at a time. Here's what that conversation looks like:

---

**Guardian:** What does your app do? Describe it in one or two sentences, like you'd explain it to a friend.

**You:** It's a waitlist. People sign up with their email, and I can invite them when I'm ready to let them in.

---

**Guardian:** Who uses the app? Is there just one type of user, or are there different roles — like regular users and admins?

**You:** Two types. Regular people who sign up from the landing page, and me as the admin who decides who gets invited.

---

**Guardian:** What's the main thing your app tracks or stores?

**You:** Signups. Each one has an email address and a name.

---

**Guardian:** For each signup — what information do you need to store about it?

**You:** Email, name, when they signed up, and whether they've been invited yet or rejected.

---

**Guardian:** Does anything go through stages or statuses?

**You:** Yes — a signup starts as pending, then either gets invited or rejected.

---

**Guardian:** What are the key things someone can do in the app?

**You:** Public: submit your email to join the waitlist. Admin: view all signups, send an invitation, or reject someone.

---

**Guardian:** Are there any rules the app must enforce?

**You:** Email can't be empty. You can't invite someone who's already been rejected. And the email sending service needs an API key configured or it'll crash.

---

**Guardian:** Does the app connect to any outside services?

**You:** SendGrid for sending the invitation emails.

---

**Guardian:** What secret keys or environment variables does the app need?

**You:** SENDGRID_API_KEY.

---

**Guardian:** Great, I have everything I need. Let me build your spec.

---

Guardian takes your answers and generates a `requirements.md` in your project folder. You never have to write or read it — it's there so Guardian can enforce the rules while Claude codes.

```
✓ requirements.md written
✓ manifest.json written — enforcement is active
```

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
    sendgrid_client.send_invite(signup["email"], signup["name"])
    db.update_status(signup_id, "invited")
    return jsonify({"ok": True})
```

Looks reasonable. But Guardian sees two problems.

---

## Step 4: Guardian catches the bugs

The moment Claude writes that file, Guardian fires automatically. Claude sees this feedback in the same turn:

```
Guardian: 2 rule violation(s) in app.py

  RULE_02 [HIGH]:8 — SendGrid API Key Required
    Fix: check that SENDGRID_API_KEY is set before executing the operation.
    Python: if not os.getenv('SENDGRID_API_KEY'): raise/return

  RULE_03 [MEDIUM]:8 — Only Pending Signups Can Be Invited
    Fix: add a guard to check entity.status == 'pending' before proceeding
```

Claude doesn't move on. It fixes both issues in the same turn:

```python
@app.route("/api/signups/<int:signup_id>/invite", methods=["POST"])
def send_invite(signup_id):
    if not os.getenv("SENDGRID_API_KEY"):
        abort(500, "Email API key not configured")

    signup = db.get_signup(signup_id)
    if not signup:
        abort(404)

    if signup["status"] != "pending":
        abort(400, "Cannot invite a signup that is not in pending status")

    sendgrid_client.send_invite(signup["email"], signup["name"])
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
T06: Missing SENDGRID_API_KEY           [HIGH]   Call invite with no env var set
```

Hand this to Claude:

> *"Go through each test in adversarial-tests.md and verify the code handles it. Fix anything that doesn't."*

---

## Step 6: Run the security audit

> *"Run security-audit for this project"*

Guardian checks whether any route is touching data it shouldn't. In this example, if the public signup endpoint accidentally had access to send invites, Guardian would catch it:

```
S01 [HIGH]: Unguarded write to Signup in public_routes.py:34
  Write actors: AdminAPI
  Blocked actors: PublicAPI
  Fix: Move this endpoint to the admin router or add an admin check.
```

---

## What just happened

You answered nine plain-English questions. Guardian turned your answers into a set of rules. Every time Claude wrote something that broke one of those rules, Guardian flagged it immediately — in the same turn, before it could become a bug.

The app you end up with matches what you described. Not approximately. Exactly.

---

## Try it yourself

1. Clone the repo and run `./setup.sh`
2. Create a new project folder and open Claude Code in it
3. Say: *"Interview me to build my spec"*
4. Answer the questions in plain English
5. Start building

If you already have an existing codebase:

> *"Run generate-spec for this project"*

Guardian will read your code and write the spec for you, then you're enforced from that point forward.
