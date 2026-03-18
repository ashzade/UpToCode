---
feature_id: user_auth
version: 1.0.0
status: approved
owner: platform-team
depends_on:
  - email_service
  - billing_api
tags:
  - auth
  - security
  - subscriptions
---

# User Authentication

Provides secure login and session management for registered users.
Integrates with the subscription entitlement system to gate pro features,
and with the risk engine to detect fraudulent login attempts.

## External State Providers

### SubscriptionService
source: billing-api
provides: current subscription tier and entitlement flags for a user
lookup_key: user_id
Methods:
  - tier(user_id: uuid): string
  - is_active(user_id: uuid): boolean

### FraudSignals
source: risk-engine
provides: real-time fraud score indexed by email address
lookup_key: email
Methods:
  - score(email: string): decimal

## State Machine

### States

- PENDING_VERIFICATION – account created, email not yet confirmed
- ACTIVE – fully authenticated and usable
- SUSPENDED – access revoked by admin action
- LOCKED – temporarily locked after failed login attempts
- DELETED – soft-deleted, PII erasure scheduled

### Transitions

#### PENDING_VERIFICATION → ACTIVE
Trigger: User clicks email verification link
Guard: RULE_01
Action: send_email(WELCOME_TEMPLATE), emit_event(USER_ACTIVATED)

#### ACTIVE → LOCKED
Trigger: Failed login attempt recorded
Guard: RULE_02
Action: send_email(ACCOUNT_LOCKED_TEMPLATE), invalidate_sessions(entity.id)

#### LOCKED → ACTIVE
Trigger: User completes unlock flow
Guard: RULE_03 AND RULE_SEC_01

#### ACTIVE → SUSPENDED
Trigger: Admin issues suspension
Guard: RULE_SEC_02
Action: invalidate_sessions(entity.id), emit_event(USER_SUSPENDED)

#### ACTIVE → DELETED
Trigger: User requests account deletion
Guard: RULE_04
Action: emit_event(USER_DELETION_REQUESTED), set_field(entity.deleted_at, NOW())

#### SUSPENDED → ACTIVE
Trigger: Admin lifts suspension
Guard: RULE_SEC_02
Action: send_email(ACCOUNT_REINSTATED_TEMPLATE), emit_event(USER_REINSTATED)

## Actors & Access

### Guest
Read: none
Write: email, password_hash

### AuthenticatedUser
Read: *
Write: email, password_hash, display_name

### Admin
Inherits: AuthenticatedUser
Write: user.status, user.auth_status

### Logic Enforcement

RULE_SEC_01: CRITICAL → reject, audit_log, alert
RULE_SEC_02: HIGH → reject, audit_log
RULE_02: MEDIUM → audit_log, alert
RULE_05: HIGH → reject, redirect(/upgrade)
RULE_06: LOW → audit_log

## Data Model

### User

id:                  uuid | primary | auto-gen
email:               string | unique | required | indexed | pii
password_hash:       string | required | sensitive
display_name:        string | nullable
status:              enum('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DELETED') | required | default(PENDING_VERIFICATION)
failed_login_count:  integer | default(0)
subscription_tier:   string | external(SubscriptionService) | indexed
fraud_score:         decimal | external(FraudSignals) | nullable
created_at:          timestamp | auto-gen
updated_at:          timestamp | auto-gen
deleted_at:          timestamp | nullable

### Session

id:            uuid | primary | auto-gen
user_id:       uuid | required | indexed | fk(User.id, many-to-one)
created_at:    timestamp | auto-gen
expires_at:    timestamp | required
ip_address:    string | sensitive
user_agent:    string | nullable

## Computed Properties

### failed_logins_15m
Aggregate: COUNT
Entity: LoginAttempt
Filter: entity.user_id == User.id AND entity.success == false
Window: 15m rolling

### outstanding_charges
Aggregate: EXISTS
Entity: Charge
Filter: entity.user_id == User.id AND entity.status == 'pending'
Window: none

## Logic Rules

### Validation Rules

#### RULE_01: Email Verification Token Valid
Type: Validation
Entity: User
Condition: entity.verification_token == token.value AND token.created_at > NOW() - INTERVAL(24, hours)
Message: "Verification link is invalid or has expired."

#### RULE_03: Unlock Token Valid
Type: Validation
Entity: User
Condition: entity.unlock_token == token.value AND token.created_at > NOW() - INTERVAL(1, hours)
Message: "Unlock link is invalid or has expired."

### Business Rules

#### RULE_02: Max Failed Login Attempts
Type: Business
Entity: User
Condition: failed_logins_15m >= 5
Message: "Account locked due to too many failed login attempts."

#### RULE_04: Deletion Requires No Pending Charges
Type: Business
Entity: User
Condition: entity.status == 'ACTIVE' AND outstanding_charges == false
Message: "Cannot delete account with pending charges."

#### RULE_05: Pro Feature Gate
Type: Business
Entity: User
Condition: SubscriptionService.tier(entity.id) != 'pro' AND entity.requested_resource_requires_pro == true
Message: "This feature requires a Pro subscription."

#### RULE_06: Fraud Score Threshold
Type: Business
Entity: User
Condition: FraudSignals.score(entity.email) > 0.85
Message: "Login attempt flagged for review."

#### RULE_SEC_01: Reauthentication Required for Unlock
Type: Security
Entity: User
Condition: actor.type == 'AuthenticatedUser' AND Session.created_at < NOW() - INTERVAL(30, minutes)
Message: "Please re-authenticate to complete this action."

#### RULE_SEC_02: Admin Suspension Audit
Type: Security
Entity: User
Condition: actor.type == 'Admin' AND (entity.status == 'SUSPENDED' OR entity.status == 'ACTIVE')
Message: "Admin state changes require a documented reason and are audit-logged."
