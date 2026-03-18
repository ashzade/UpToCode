import { ExternalProvider, ProviderMethod } from '../types';
import { ParseError } from '../errors';

function parseMethodSignature(sig: string): ProviderMethod {
  // e.g. "tier(user_id: uuid): string"
  const parenOpen = sig.indexOf('(');
  const parenClose = sig.indexOf(')');
  if (parenOpen === -1 || parenClose === -1) {
    throw new ParseError(`Invalid method signature: "${sig}"`, undefined, 'External State Providers');
  }

  const name = sig.slice(0, parenOpen).trim();
  const paramStr = sig.slice(parenOpen + 1, parenClose).trim();
  const afterParen = sig.slice(parenClose + 1).trim();
  const returnsMatch = afterParen.match(/^:\s*(.+)$/);
  if (!returnsMatch) {
    throw new ParseError(`Method "${name}" missing return type`, undefined, 'External State Providers');
  }
  const returns = returnsMatch[1].trim();

  const params: Array<{ name: string; type: string }> = [];
  if (paramStr) {
    for (const p of paramStr.split(',')) {
      const parts = p.trim().split(':');
      if (parts.length !== 2) {
        throw new ParseError(`Invalid param in method "${name}": "${p.trim()}"`, undefined, 'External State Providers');
      }
      params.push({ name: parts[0].trim(), type: parts[1].trim() });
    }
  }

  return { name, params, returns };
}

export function parseProviders(content: string): Record<string, ExternalProvider> {
  const providers: Record<string, ExternalProvider> = {};
  const lines = content.split('\n');

  let currentProvider: string | null = null;
  let inMethods = false;
  let current: Partial<ExternalProvider> & { methods: ProviderMethod[] } = { methods: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Level-3 heading = new provider
    if (trimmed.startsWith('### ')) {
      if (currentProvider) {
        providers[currentProvider] = current as ExternalProvider;
      }
      currentProvider = trimmed.slice(4).trim();
      inMethods = false;
      current = { methods: [] };
      continue;
    }

    if (!currentProvider) continue;

    if (trimmed.startsWith('source:')) {
      current.source = trimmed.slice(7).trim();
      inMethods = false;
    } else if (trimmed.startsWith('provides:')) {
      current.provides = trimmed.slice(9).trim();
      inMethods = false;
    } else if (trimmed.startsWith('lookup_key:')) {
      current.lookupKey = trimmed.slice(11).trim();
      inMethods = false;
    } else if (trimmed === 'Methods:') {
      inMethods = true;
    } else if (inMethods && trimmed.startsWith('- ')) {
      const sig = trimmed.slice(2).trim();
      current.methods.push(parseMethodSignature(sig));
    }
  }

  if (currentProvider) {
    providers[currentProvider] = current as ExternalProvider;
  }

  return providers;
}
