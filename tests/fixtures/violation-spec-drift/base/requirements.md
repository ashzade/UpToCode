---
feature_id: user_profile
version: 1.0.0
status: approved
owner: platform-team
---

# User Profile

Users can view and update their profile. Access to premium features is not yet implemented.

## Actors & Access

### AuthenticatedUser
Read: *
Write: User.display_name, User.email

### Logic Enforcement

RULE_01: HIGH → reject

## Data Model

### User

id:           uuid | primary | auto-gen
email:        string | unique | required | pii
display_name: string | nullable
created_at:   timestamp | auto-gen

## Logic Rules

### Validation Rules

#### RULE_01: Email Format
Type: Validation
Entity: User
Condition: entity.email != ''
Message: "A valid email is required."
