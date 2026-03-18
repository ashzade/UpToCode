"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../src/index");
const fs_1 = require("fs");
const path_1 = require("path");
const assert_1 = __importDefault(require("assert"));
const fixture = (0, fs_1.readFileSync)((0, path_1.join)(__dirname, 'fixtures/user-auth.md'), 'utf-8');
function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
    }
    catch (e) {
        console.error(`✗ ${name}: ${e}`);
        process.exitCode = 1;
    }
}
let manifest;
test('parses without throwing', () => { manifest = (0, index_1.parse)(fixture); });
test('meta: feature_id', () => assert_1.default.strictEqual(manifest.meta.featureId, 'user_auth'));
test('meta: status', () => assert_1.default.strictEqual(manifest.meta.status, 'approved'));
test('feature: name', () => assert_1.default.strictEqual(manifest.feature.name, 'User Authentication'));
test('providers: SubscriptionService methods', () => {
    assert_1.default.ok(manifest.externalProviders.SubscriptionService);
    assert_1.default.strictEqual(manifest.externalProviders.SubscriptionService.methods.length, 2);
});
test('state machine: 5 states', () => assert_1.default.strictEqual(Object.keys(manifest.stateMachine.states).length, 5));
test('state machine: transitions have actions', () => {
    const t = manifest.stateMachine.transitions.find((t) => t.from === 'PENDING_VERIFICATION');
    assert_1.default.ok(t);
    assert_1.default.strictEqual(t.actions[0].type, 'send_email');
});
test('actors: Admin inherits AuthenticatedUser', () => assert_1.default.strictEqual(manifest.actors.Admin.inherits, 'AuthenticatedUser'));
test('data model: Session.user_id has fk modifier', () => {
    const fk = manifest.dataModel.Session.fields.user_id.modifiers.find((m) => m.name === 'fk');
    assert_1.default.ok(fk);
    assert_1.default.strictEqual(fk.args[0], 'User.id');
    assert_1.default.strictEqual(fk.args[1], 'many-to-one');
});
test('computed: failed_logins_15m window', () => {
    const cp = manifest.computedProperties.failed_logins_15m;
    assert_1.default.ok(cp);
    assert_1.default.strictEqual(cp.window.value, 15);
    assert_1.default.strictEqual(cp.window.unit, 'm');
});
test('rules: RULE_02 condition references computed property', () => {
    assert_1.default.ok(manifest.rules.RULE_02.condition.includes('failed_logins_15m'));
});
test('enforcement: RULE_SEC_01 is CRITICAL', () => {
    const d = manifest.enforcement.find((e) => e.ruleId === 'RULE_SEC_01');
    assert_1.default.ok(d);
    assert_1.default.strictEqual(d.severity, 'CRITICAL');
});
test('validation: cross-references pass', () => assert_1.default.ok(manifest)); // validate() is called inside parse()
