import { BackendError } from '../core/errors';
import { bus } from '../core/bus';
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
  // a reachable server that names its contract is the real game; one flaky RPC read on its side (ok: false) is no
  // reason to drop a player into the demo. Every action handles its own errors.
  if (!health.contract) return { offline: 'The chain is not reachable right now. Playing the offline demo.' };
  const contract = (import.meta.env.VITE_REALM_CONTRACT as string | undefined) || health.contract;
  const chain = new ChainBackend(api, contract, health.relayer_account);
  // The server is up, so this IS the real game. Opening a brand-new guest wallet (fund it, wait for its key on
  // chain) takes several seconds; never block the title screen on it, and never fall back to the demo because of
  // it. Every action waits for the session anyway; a failure is said out loud and the next action retries.
  void chain.init().catch((err) => {
    const why = err instanceof BackendError || err instanceof Error ? err.message : 'Your wallet is still being created.';
    bus.emit('toast', `${why.replace(/\.$/, '')}. Retrying on your next move.`);
  });
  return chain;
}
