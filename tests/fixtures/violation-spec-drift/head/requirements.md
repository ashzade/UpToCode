---
feature_id: user_profile
version: 1.1.0
status: approved
owner: platform-team
---

# User Profile

Users can view and update their profile. Pro users get access to premium features
via Stripe subscription.

## External State Providers

### StripeService
source: stripe-api
provides: current subscription status for a user
lookup_key: user_id
Methods:
  - status(user_id: uuid): string

## Actors & Access

### AuthenticatedUser
Read: *
Write: User.display_name, User.email

### System
Read: *
Write: User.is_pro

### Logic Enforcement

RULE_01: HIGH → reject
RULE_02: HIGH → reject, audit_log
RULE_SEC_01: CRITICAL → reject, audit_log, alert

## Data Model

### User

id:           uuid | primary | auto-gen
email:        string | unique | required | pii
display_name: string | nullable
is_pro:       boolean | default(false) | sensitive
stripe_status: string | external(StripeService) | nullable
created_at:   timestamp | auto-gen

## Logic Rules

### Validation Rules

#### RULE_01: Email Format
Type: Validation
Entity: User
Condition: entity.email != ''
Message: "A valid email is required."

### Business Rules

#### RULE_02: Pro Feature Gate
Type: Business
Entity: User
Condition: entity.is_pro == true
Message: "This feature requires a Pro subscription."
Scope: Entity(User), Actor(AuthenticatedUser)

#### RULE_SEC_01: Only System Can Set is_pro
Type: Security
Entity: User
Condition: actor.type == 'System'
Message: "The is_pro flag can only be set by the system via Stripe webhook."
Scope: Entity(User)
