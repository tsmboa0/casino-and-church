import { BackendError } from '../core/errors';
import { ChainBackend } from './chainBackend';
import type { Health } from './types';

/**
 * Chain mode boot. Returns the backend, or the reason the game falls back to the offline demo
 * (the server is down, or it could not open a guest account, e.g. its daily quota for this network).
 */
export async function connectChain(api: string): Promise<ChainBackend | { offline: string }> {
  let health: Health;
  try {
    // the server caches /healthz; 8 s still covers a cold start on a slow RPC
    const res = await fetch(`${api}/healthz`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { offline: 'The game server is not answering. Playing the offline demo.' };
    health = await res.json() as Health;
  } catch {
    return { offline: 'The game server is not answering. Playing the offline demo.' };
  }
  if (!health.ok || !health.contract) return { offline: 'The chain is not reachable right now. Playing the offline demo.' };
  const contract = (import.meta.env.VITE_REALM_CONTRACT as string | undefined) || health.contract;
  const chain = new ChainBackend(api, contract, health.relayer_account);
  try {
    await Promise.race([chain.init(), new Promise((_, rej) => setTimeout(() => rej(new BackendError('timeout', 'The chain is slow to answer.')), 15_000))]);
  } catch (err) {
    chain.stop();
    const why = err instanceof Error ? err.message : 'Could not open your account.';
    return { offline: `${why.replace(/\.$/, '')}. Playing the offline demo.` };
  }
  return chain;
}
