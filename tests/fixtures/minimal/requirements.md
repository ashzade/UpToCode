---
feature_id: contact_form
version: 1.0.0
status: draft
owner: solo-dev
---

# Contact Form

Allows visitors to submit a contact message. No authentication required.

## Data Model

### ContactMessage

id:         uuid | primary | auto-gen
name:       string | required
email:      string | required | regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) | pii
body:       string | required
created_at: timestamp | auto-gen

## Logic Rules

### Validation Rules

#### RULE_01: Email Format Valid
Type: Validation
Entity: ContactMessage
Condition: entity.email != ''
Message: "A valid email address is required."

#### RULE_02: Body Not Empty
Type: Validation
Entity: ContactMessage
Condition: entity.body != ''
Message: "Message body cannot be empty."
