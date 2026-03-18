---
feature_id: blog
version: 1.0.0
status: approved
owner: content-team
tags:
  - content
  - publishing
---

# Blog Publishing

Authors can create and publish posts. Readers can leave comments on published posts.
Admins can remove any post or comment.

## State Machine

### States

- DRAFT – post created, not visible to readers
- PUBLISHED – post is publicly visible
- ARCHIVED – post hidden from readers, retained for records

### Transitions

#### DRAFT → PUBLISHED
Trigger: Author clicks Publish
Guard: RULE_01
Action: emit_event(POST_PUBLISHED)

#### PUBLISHED → ARCHIVED
Trigger: Author or Admin archives post
Guard: RULE_02
Action: emit_event(POST_ARCHIVED)

#### PUBLISHED → DRAFT
Trigger: Author unpublishes post

## Actors & Access

### Reader
Read: Post.title, Post.body, Post.published_at, Comment.body, Comment.author_id
Write: none

### Author
Read: *
Write: Post.title, Post.body, Post.status

### Admin
Inherits: Author
Write: Post.status, Comment.is_removed

### Logic Enforcement

RULE_SEC_01: CRITICAL → reject, audit_log
RULE_02: HIGH → reject, audit_log

## Data Model

### Post

id:           uuid | primary | auto-gen
author_id:    uuid | required | indexed | fk(User.id, many-to-one)
title:        string | required
body:         string | required
status:       enum('DRAFT', 'PUBLISHED', 'ARCHIVED') | required | default(DRAFT)
published_at: timestamp | nullable
created_at:   timestamp | auto-gen
updated_at:   timestamp | auto-gen

### Comment

id:         uuid | primary | auto-gen
post_id:    uuid | required | indexed | fk(Post.id, many-to-one)
author_id:  uuid | required | indexed | fk(User.id, many-to-one)
body:       string | required
is_removed: boolean | default(false)
created_at: timestamp | auto-gen

### PostTag

post_id: uuid | required | fk(Post.id, many-to-one)
tag_id:  uuid | required | fk(Tag.id, many-to-one)

### Tag

id:   uuid | primary | auto-gen
name: string | unique | required

## Logic Rules

### Validation Rules

#### RULE_01: Post Has Title and Body
Type: Validation
Entity: Post
Condition: entity.title != '' AND entity.body != ''
Message: "Post must have a title and body before publishing."

### Business Rules

#### RULE_02: Only Author or Admin Can Archive
Type: Business
Entity: Post
Condition: actor.type == 'Author' OR actor.type == 'Admin'
Message: "Only the post author or an admin can archive a post."

#### RULE_SEC_01: Reader Cannot Write
Type: Security
Entity: Post
Condition: actor.type != 'Reader'
Message: "Readers do not have write access."
Scope: Actor(Reader)
