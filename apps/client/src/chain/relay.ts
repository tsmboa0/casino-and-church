import { TGAS, humanError, toBase64 } from '@cnc/shared';
import { BackendError } from '../core/errors';
import { getSession } from './auth';
import { estimatedHeight } from './rpc';

/** relay a call; with wait, the server returns the executed transaction too (saves the client's own polling) */
export async function relay(api: string, contract: string, method: string, args: unknown, gas = 40n * TGAS, wait = false): Promise<{ hash: string; tx?: any }> {
  const t0 = performance.now();
  const session = await getSession(api);
  const height = await estimatedHeight();             // no round trip per bet (it used to fetch the tip every time)
  const t1 = performance.now();
  const signed = await session.signDelegate({
    receiverId: contract,
    methodName: method,
    args: new TextEncoder().encode(JSON.stringify(args ?? {})),
    gas,
    maxBlockHeight: height + 50n,                    // the relayer accepts up to 100 blocks ahead
  });
  const res = await fetch(`${api}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed_delegate: toBase64(signed), ...(wait ? { wait: true } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(body.error || 'bad_args');
    throw new BackendError(code, body.message || humanError(code));
  }
  try { if (localStorage.getItem('cncTiming') === '1') console.info(`[cnc-timing]   sign ${Math.round(t1 - t0)} ms, POST /relay ${Math.round(performance.now() - t1)} ms`); } catch { /* */ }
  return { hash: String(body.tx_hash), ...(body.tx ? { tx: body.tx } : {}) };
}
