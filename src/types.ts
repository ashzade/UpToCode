export interface Manifest {
  meta: Meta;
  feature: Feature;
  externalProviders: Record<string, ExternalProvider>;
  stateMachine: StateMachine;
  actors: Record<string, Actor>;
  enforcement: EnforcementDirective[];
  dataModel: Record<string, Entity>;
  computedProperties: Record<string, ComputedProperty>;
  rules: Record<string, Rule>;
}

export interface Meta {
  featureId: string;
  version: string;
  status: 'draft' | 'review' | 'approved' | 'deprecated';
  owner: string;
  dependsOn: string[];
  tags: string[];
}

export interface Feature {
  name: string;
  intent: string;
}

export interface ProviderMethod {
  name: string;
  params: Array<{ name: string; type: string }>;
  returns: string;
}

export interface ExternalProvider {
  source: string;
  provides: string;
  lookupKey: string;
  methods: ProviderMethod[];
}

export interface StateTransition {
  from: string;
  to: string;
  trigger?: string;
  guard?: string;       // raw guard expression string
  actions: TransitionAction[];
}

export interface TransitionAction {
  type: 'send_email' | 'emit_event' | 'set_field' | 'call_webhook' | 'invalidate_sessions';
  args: string[];
}

export interface StateMachine {
  states: Record<string, string>;    // STATE_NAME → description
  transitions: StateTransition[];
}

export interface Actor {
  inherits?: string;
  read: string[] | '*' | 'none';
  write: string[] | '*' | 'none';
}

export interface EnforcementDirective {
  ruleId: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  responses: Array<{ action: string; arg?: string }>;
}

export interface FieldModifier {
  name: string;
  args: string[];
}

export interface Field {
  name: string;
  type: string;
  modifiers: FieldModifier[];
}

export interface Entity {
  fields: Record<string, Field>;
}

export interface ComputedProperty {
  aggregate: 'COUNT' | 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'EXISTS';
  entity: string;
  filter: string;        // raw predicate string
  window: { value: number; unit: string; type: 'rolling' } | null;
}

export interface Rule {
  id: string;
  title: string;
  type: 'Validation' | 'Business' | 'Security';
  entity: string;
  condition: string;     // raw predicate string
  message: string;
  references: string[];
}
