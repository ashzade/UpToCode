import { parse } from '../src/index';
import { readFileSync } from 'fs';
import { join } from 'path';
import assert from 'assert';

const fixture = readFileSync(join(__dirname, 'fixtures/user-auth/requirements.md'), 'utf-8');

function test(name: string, fn: () => void) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}: ${e}`); process.exitCode = 1; }
}

// --- user-auth fixture ---
let manifest: any;
test('user-auth: parses without throwing', () => { manifest = parse(fixture); });
test('user-auth: meta: feature_id', () => assert.strictEqual(manifest.meta.featureId, 'user_auth'));
test('user-auth: meta: status', () => assert.strictEqual(manifest.meta.status, 'approved'));
test('user-auth: feature: name', () => assert.strictEqual(manifest.feature.name, 'User Authentication'));
test('user-auth: providers: SubscriptionService methods', () => {
  assert.ok(manifest.externalProviders.SubscriptionService);
  assert.strictEqual(manifest.externalProviders.SubscriptionService.methods.length, 2);
});
test('user-auth: state machine: 5 states', () => assert.strictEqual(Object.keys(manifest.stateMachine.states).length, 5));
test('user-auth: state machine: transitions have actions', () => {
  const t = manifest.stateMachine.transitions.find((t: any) => t.from === 'PENDING_VERIFICATION');
  assert.ok(t);
  assert.strictEqual(t.actions[0].type, 'send_email');
});
test('user-auth: actors: Admin inherits AuthenticatedUser', () => assert.strictEqual(manifest.actors.Admin.inherits, 'AuthenticatedUser'));
test('user-auth: data model: Session.user_id has fk modifier', () => {
  const fk = manifest.dataModel.Session.fields.user_id.modifiers.find((m: any) => m.name === 'fk');
  assert.ok(fk);
  assert.strictEqual(fk.args[0], 'User.id');
  assert.strictEqual(fk.args[1], 'many-to-one');
});
test('user-auth: computed: failed_logins_15m window', () => {
  const cp = manifest.computedProperties.failed_logins_15m;
  assert.ok(cp);
  assert.strictEqual(cp.window.value, 15);
  assert.strictEqual(cp.window.unit, 'm');
});
test('user-auth: rules: RULE_02 condition references computed property', () => {
  assert.ok(manifest.rules.RULE_02.condition.includes('failed_logins_15m'));
});
test('user-auth: enforcement: RULE_SEC_01 is CRITICAL', () => {
  const d = manifest.enforcement.find((e: any) => e.ruleId === 'RULE_SEC_01');
  assert.ok(d);
  assert.strictEqual(d.severity, 'CRITICAL');
});
test('user-auth: validation: cross-references pass', () => assert.ok(manifest)); // validate() is called inside parse()

// --- minimal fixture ---
const minimalFixture = readFileSync(join(__dirname, 'fixtures/minimal/requirements.md'), 'utf-8');
let minimalManifest: any;
test('minimal: parses without throwing', () => { minimalManifest = parse(minimalFixture); });
test('minimal: meta: feature_id is contact_form', () => assert.strictEqual(minimalManifest.meta.featureId, 'contact_form'));
test('minimal: meta: status is draft', () => assert.strictEqual(minimalManifest.meta.status, 'draft'));
test('minimal: no external providers', () => assert.strictEqual(Object.keys(minimalManifest.externalProviders).length, 0));
test('minimal: no state machine states', () => assert.strictEqual(Object.keys(minimalManifest.stateMachine.states).length, 0));
test('minimal: data model has ContactMessage entity', () => assert.ok(minimalManifest.dataModel.ContactMessage));
test('minimal: ContactMessage has 5 fields', () => {
  assert.strictEqual(Object.keys(minimalManifest.dataModel.ContactMessage.fields).length, 5);
});
test('minimal: ContactMessage.email has pii modifier', () => {
  const emailField = minimalManifest.dataModel.ContactMessage.fields.email;
  assert.ok(emailField);
  const pii = emailField.modifiers.find((m: any) => m.name === 'pii');
  assert.ok(pii);
});
test('minimal: 2 rules defined', () => assert.strictEqual(Object.keys(minimalManifest.rules).length, 2));
test('minimal: RULE_01 is Validation type', () => assert.strictEqual(minimalManifest.rules.RULE_01.type, 'Validation'));
test('minimal: RULE_02 condition checks body', () => assert.ok(minimalManifest.rules.RULE_02.condition.includes('entity.body')));

// --- multi-entity fixture ---
const multiFixture = readFileSync(join(__dirname, 'fixtures/multi-entity/requirements.md'), 'utf-8');
let multiManifest: any;
test('multi-entity: parses without throwing', () => { multiManifest = parse(multiFixture); });
test('multi-entity: meta: feature_id is blog', () => assert.strictEqual(multiManifest.meta.featureId, 'blog'));
test('multi-entity: meta: tags include content', () => assert.ok(multiManifest.meta.tags.includes('content')));
test('multi-entity: state machine has 3 states', () => assert.strictEqual(Object.keys(multiManifest.stateMachine.states).length, 3));
test('multi-entity: DRAFT → PUBLISHED transition has guard RULE_01', () => {
  const t = multiManifest.stateMachine.transitions.find((t: any) => t.from === 'DRAFT' && t.to === 'PUBLISHED');
  assert.ok(t);
  assert.strictEqual(t.guard, 'RULE_01');
});
test('multi-entity: DRAFT → PUBLISHED emits event', () => {
  const t = multiManifest.stateMachine.transitions.find((t: any) => t.from === 'DRAFT' && t.to === 'PUBLISHED');
  assert.ok(t);
  assert.strictEqual(t.actions[0].type, 'emit_event');
  assert.strictEqual(t.actions[0].args[0], 'POST_PUBLISHED');
});
test('multi-entity: Admin inherits Author', () => assert.strictEqual(multiManifest.actors.Admin.inherits, 'Author'));
test('multi-entity: Reader has write: none', () => assert.strictEqual(multiManifest.actors.Reader.write, 'none'));
test('multi-entity: 4 entities in data model', () => assert.strictEqual(Object.keys(multiManifest.dataModel).length, 4));
test('multi-entity: Post.author_id has fk modifier', () => {
  const fk = multiManifest.dataModel.Post.fields.author_id.modifiers.find((m: any) => m.name === 'fk');
  assert.ok(fk);
  assert.strictEqual(fk.args[0], 'User.id');
});
test('multi-entity: Comment.post_id has fk to Post.id', () => {
  const fk = multiManifest.dataModel.Comment.fields.post_id.modifiers.find((m: any) => m.name === 'fk');
  assert.ok(fk);
  assert.strictEqual(fk.args[0], 'Post.id');
});
test('multi-entity: 3 rules defined', () => assert.strictEqual(Object.keys(multiManifest.rules).length, 3));
test('multi-entity: RULE_SEC_01 is Security type', () => assert.strictEqual(multiManifest.rules.RULE_SEC_01.type, 'Security'));
test('multi-entity: enforcement RULE_SEC_01 is CRITICAL', () => {
  const d = multiManifest.enforcement.find((e: any) => e.ruleId === 'RULE_SEC_01');
  assert.ok(d);
  assert.strictEqual(d.severity, 'CRITICAL');
});
