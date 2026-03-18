import { Actor, EnforcementDirective } from '../types';
import { ParseError } from '../errors';

function parseAccessList(value: string): string[] | '*' | 'none' {
  const v = value.trim();
  if (v === '*') return '*';
  if (v === 'none') return 'none';
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function parseEnforcementLine(line: string): EnforcementDirective {
  // RULE_SEC_01: CRITICAL → reject, audit_log, alert
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) {
    throw new ParseError(`Invalid enforcement line: "${line}"`, undefined, 'Actors & Access');
  }
  const ruleId = line.slice(0, colonIdx).trim();
  const rest = line.slice(colonIdx + 1).trim();

  const arrowIdx = rest.indexOf('→');
  if (arrowIdx === -1) {
    throw new ParseError(`Enforcement line missing "→": "${line}"`, undefined, 'Actors & Access');
  }

  const severity = rest.slice(0, arrowIdx).trim() as EnforcementDirective['severity'];
  const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  if (!validSeverities.includes(severity)) {
    throw new ParseError(`Invalid severity "${severity}" in enforcement line: "${line}"`, undefined, 'Actors & Access');
  }

  const actionsStr = rest.slice(arrowIdx + 1).trim();
  const responses: Array<{ action: string; arg?: string }> = [];

  for (const actionPart of actionsStr.split(',')) {
    const a = actionPart.trim();
    const parenOpen = a.indexOf('(');
    if (parenOpen !== -1) {
      const parenClose = a.lastIndexOf(')');
      const action = a.slice(0, parenOpen).trim();
      const arg = a.slice(parenOpen + 1, parenClose).trim();
      responses.push({ action, arg });
    } else {
      responses.push({ action: a });
    }
  }

  return { ruleId, severity, responses };
}

export function parseActors(content: string): {
  actors: Record<string, Actor>;
  enforcement: EnforcementDirective[];
} {
  const actors: Record<string, Actor> = {};
  const enforcement: EnforcementDirective[] = [];
  const lines = content.split('\n');

  let currentActor: string | null = null;
  let inEnforcement = false;
  let currentActorData: Partial<Actor> = {};

  function saveActor() {
    if (currentActor) {
      const actor: Actor = {
        read: currentActorData.read ?? 'none',
        write: currentActorData.write ?? 'none',
      };
      if (currentActorData.inherits) {
        actor.inherits = currentActorData.inherits;
      }
      actors[currentActor] = actor;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === '### Logic Enforcement') {
      saveActor();
      currentActor = null;
      inEnforcement = true;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      saveActor();
      currentActor = trimmed.slice(4).trim();
      currentActorData = {};
      inEnforcement = false;
      continue;
    }

    if (inEnforcement) {
      if (trimmed && !trimmed.startsWith('#')) {
        enforcement.push(parseEnforcementLine(trimmed));
      }
      continue;
    }

    if (currentActor) {
      if (trimmed.startsWith('Inherits:')) {
        currentActorData.inherits = trimmed.slice(9).trim();
      } else if (trimmed.startsWith('Read:')) {
        currentActorData.read = parseAccessList(trimmed.slice(5).trim());
      } else if (trimmed.startsWith('Write:')) {
        currentActorData.write = parseAccessList(trimmed.slice(6).trim());
      }
    }
  }

  saveActor();

  return { actors, enforcement };
}
