---
feature_id: account_unlock
version: 1.0.0
status: approved
owner: platform-team
---

# Account Unlock

Allows locked users to unlock their account after verifying identity.
Requires recent authentication to prevent session hijacking.

## State Machine

### States

- LOCKED – account locked after failed login attempts
- ACTIVE – account active and usable

### Transitions

#### LOCKED → ACTIVE
Trigger: User submits unlock form
Guard: RULE_01 AND RULE_SEC_01
Action: emit_event(ACCOUNT_UNLOCKED)

## Actors & Access

### AuthenticatedUser
Read: *
Write: User.unlock_token

### Logic Enforcement

RULE_SEC_01: CRITICAL → reject, audit_log, alert

## Data Model

### User

id:           uuid | primary | auto-gen
status:       enum('LOCKED', 'ACTIVE') | required | default(ACTIVE)
unlock_token: string | nullable | sensitive
created_at:   timestamp | auto-gen

### Session

id:         uuid | primary | auto-gen
user_id:    uuid | required | indexed | fk(User.id, many-to-one)
created_at: timestamp | auto-gen
expires_at: timestamp | required

## Logic Rules

### Validation Rules

#### RULE_01: Unlock Token Valid
Type: Validation
Entity: User
Condition: entity.unlock_token != ''
Message: "Invalid unlock token."

### Business Rules

#### RULE_SEC_01: Reauthentication Required
Type: Security
Entity: User
Condition: actor.type == 'AuthenticatedUser' AND Session.created_at > NOW() - INTERVAL(30, minutes)
Message: "Please re-authenticate to complete this action."
Scope: Actor(AuthenticatedUser), Transition(LOCKED → ACTIVE)
