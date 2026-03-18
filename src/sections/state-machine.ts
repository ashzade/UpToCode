import { StateMachine, StateTransition, TransitionAction } from '../types';
import { ParseError } from '../errors';

const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9_]*$/;

const VALID_ACTION_TYPES = ['send_email', 'emit_event', 'set_field', 'call_webhook', 'invalidate_sessions'] as const;

/**
 * Split a comma-separated action list, but don't split commas inside parentheses.
 */
function splitActions(raw: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of raw) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function parseAction(raw: string): TransitionAction {
  const parenOpen = raw.indexOf('(');
  if (parenOpen === -1) {
    throw new ParseError(`Action "${raw}" missing parentheses`, undefined, 'State Machine');
  }
  const type = raw.slice(0, parenOpen).trim() as TransitionAction['type'];
  if (!VALID_ACTION_TYPES.includes(type)) {
    throw new ParseError(`Unknown action type "${type}"`, undefined, 'State Machine');
  }
  const parenClose = raw.lastIndexOf(')');
  const argsStr = raw.slice(parenOpen + 1, parenClose).trim();

  // Split args by comma, respecting nested parens
  const args: string[] = [];
  if (argsStr) {
    let depth = 0;
    let current = '';
    for (const ch of argsStr) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth--; current += ch; }
      else if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) args.push(current.trim());
  }

  return { type, args };
}

export function parseStateMachine(content: string): StateMachine {
  const lines = content.split('\n');
  const states: Record<string, string> = {};
  const transitions: StateTransition[] = [];

  let inStates = false;
  let inTransitions = false;
  let currentTransition: Partial<StateTransition> & { actions: TransitionAction[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '### States') {
      inStates = true;
      inTransitions = false;
      continue;
    }
    if (trimmed === '### Transitions') {
      inStates = false;
      inTransitions = true;
      continue;
    }

    // New level-4 transition heading
    if (trimmed.startsWith('#### ') && inTransitions) {
      if (currentTransition) {
        transitions.push(currentTransition as StateTransition);
      }
      const heading = trimmed.slice(5).trim();
      const arrowIdx = heading.indexOf('→');
      if (arrowIdx === -1) {
        throw new ParseError(`Transition heading missing "→": "${heading}"`, undefined, 'State Machine');
      }
      const from = heading.slice(0, arrowIdx).trim();
      const to = heading.slice(arrowIdx + 1).trim();

      if (!SCREAMING_SNAKE_CASE.test(from)) {
        throw new ParseError(`Transition FROM state "${from}" is not SCREAMING_SNAKE_CASE`, undefined, 'State Machine');
      }
      if (!SCREAMING_SNAKE_CASE.test(to)) {
        throw new ParseError(`Transition TO state "${to}" is not SCREAMING_SNAKE_CASE`, undefined, 'State Machine');
      }

      currentTransition = { from, to, actions: [] };
      continue;
    }

    if (inStates) {
      // - STATE_NAME – description
      if (trimmed.startsWith('- ')) {
        const rest = trimmed.slice(2).trim();
        const dashIdx = rest.indexOf('–');
        if (dashIdx !== -1) {
          const stateName = rest.slice(0, dashIdx).trim();
          const desc = rest.slice(dashIdx + 1).trim();
          if (!SCREAMING_SNAKE_CASE.test(stateName)) {
            throw new ParseError(`State name "${stateName}" is not SCREAMING_SNAKE_CASE`, undefined, 'State Machine');
          }
          states[stateName] = desc;
        } else {
          const stateName = rest.trim();
          if (!SCREAMING_SNAKE_CASE.test(stateName)) {
            throw new ParseError(`State name "${stateName}" is not SCREAMING_SNAKE_CASE`, undefined, 'State Machine');
          }
          states[stateName] = '';
        }
      }
    }

    if (inTransitions && currentTransition) {
      if (trimmed.startsWith('Trigger:')) {
        currentTransition.trigger = trimmed.slice(8).trim();
      } else if (trimmed.startsWith('Guard:')) {
        currentTransition.guard = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('Action:')) {
        const actionStr = trimmed.slice(7).trim();
        const actionParts = splitActions(actionStr);
        currentTransition.actions = actionParts.map(parseAction);
      }
    }
  }

  if (currentTransition) {
    transitions.push(currentTransition as StateTransition);
  }

  return { states, transitions };
}
