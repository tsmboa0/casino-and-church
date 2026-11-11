import { sha256 } from '@noble/hashes/sha256';
import { base58Decode, base58Encode, fromBase64, toBase64 } from '@cnc/shared';

const cache = new Map<string, { at: number; value: unknown }>();

/** VITE_NEAR_RPC may be a comma-separated list; a failing endpoint hands over to the next. rpc.testnet.near.org is deprecated (429). */
// default: the game server's /rpc proxy (it holds the paid RPC key; a free provider would rate-limit a venue on one IP)
const API = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8787';
const URLS = ((import.meta.env.VITE_NEAR_RPC as string | undefined) || `${API}/rpc,https://near-testnet.drpc.org`).split(',').map((s) => s.trim()).filter(Boolean);
let active = 0;
export function rpcUrl(): string { return URLS[active % URLS.length]; }

const transient = (err: unknown) => /rpc (408|429|5\d\d)|abort|timeout|Failed to fetch|NetworkError|Load failed/i.test(err instanceof Error ? err.message : String(err));

async function rpcOnce(method: string, params: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cnc', method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message || 'rpc'} ${JSON.stringify(body.error.cause ?? body.error.data ?? '')}`);
  return body.result;
}

async function rpc(method: string, params: unknown, timeoutMs = 8_000): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < Math.max(2, URLS.length); attempt++) {
    try { return await rpcOnce(method, params, timeoutMs); } catch (err) {
      last = err;
      if (!transient(err)) throw err;
      if (URLS.length > 1) active++; else await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function viewCall(contract: string, method: string, args: unknown, finality: 'final' | 'optimistic' = 'final'): Promise<any> {
  const key = `${contract}:${method}:${JSON.stringify(args ?? {})}:${finality}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 700) return hit.value;
  const result = await rpc('query', {
    request_type: 'call_function', finality, account_id: contract, method_name: method,
    args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args ?? {}))),
  });
  const text = new TextDecoder().decode(Uint8Array.from(result.result as number[]));
  const value = text ? JSON.parse(text) : null;
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function dropView(contract: string, method: string) {
  for (const key of cache.keys()) if (key.startsWith(`${contract}:${method}:`)) cache.delete(key);
}

let tipCache: { at: number; tip: { height: bigint; hash: Uint8Array } } | null = null;
/** a recent final block (cached 5 s: it only anchors expiry heights and signing, and saves a round trip per action) */
export async function blockTip(): Promise<{ height: bigint; hash: Uint8Array }> {
  if (tipCache && Date.now() - tipCache.at < 5_000) return tipCache.tip;
  const block = await rpc('block', { finality: 'final' });
  const tip = { height: BigInt(block.header.height), hash: base58Decode(block.header.hash) };
  tipCache = { at: Date.now(), tip };
  return tip;
}

/**
 * The chain height right now, without waiting on the network: the last tip we saw plus the blocks since then
 * (NEAR makes about one a second; this errs low, never high). The tip is refreshed in the background after 15 s.
 * Only used for a delegate's expiry, which has a wide window.
 */
export async function estimatedHeight(): Promise<bigint> {
  if (!tipCache || Date.now() - tipCache.at > 60_000) return (await blockTip()).height;
  const age = Date.now() - tipCache.at;
  if (age > 15_000 && !tipRefreshing) { tipRefreshing = true; void blockTip().catch(() => {}).finally(() => { tipRefreshing = false; }); }
  return tipCache.tip.height + BigInt(Math.floor(age / 1_200));
}
let tipRefreshing = false;

export async function accessNonce(account: string, publicKey: string): Promise<bigint> {
  const row = await rpc('query', {
    request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey,
  });
  return BigInt(row.nonce);
}

export async function accountBalance(account: string): Promise<bigint> {
  const row = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: account });
  return BigInt(row.amount);
}

/** NEAR tx hash = base58(sha256(borsh(Transaction))); a signed tx is that body plus a 65-byte signature */
async function txHashOf(signed: Uint8Array): Promise<string> {
  const body = signed.slice(0, signed.length - 65);
  return base58Encode(sha256(body));        // pure JS: crypto.subtle is missing on plain-http LAN addresses (phones)
}

/** hand the tx to the network without waiting (send_tx; the legacy broadcast_tx_async only where send_tx is missing) */
export async function broadcast(signed: Uint8Array): Promise<string> {
  const hash = await txHashOf(signed);
  try {
    await rpc('send_tx', { signed_tx_base64: toBase64(signed), wait_until: 'NONE' });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/method (is )?not (available|found)|METHOD_NOT_FOUND|unknown variant/i.test(m)) await rpc('broadcast_tx_async', [toBase64(signed)]);
    else if (!transient(err)) throw err;
  }
  return hash;
}

/** poll until executed; never asks the provider to hold the request open (free plans answer 408 to long waits) */
export async function waitTx(hash: string, signer: string): Promise<any> {
  let last: unknown;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      const tx = await rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' });
      const stage = String(tx?.final_execution_status ?? '');
      const pending = stage === 'NONE' || stage === 'INCLUDED' || stage === 'INCLUDED_FINAL';
      if (!pending && tx?.status && typeof tx.status === 'object' && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status || 'Failure' in tx.status)) return tx;
      last = tx;
    } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw last instanceof Error ? last : new Error('The transaction did not finish.');
}

export function txEvents(tx: any): { event: string; data: any }[] {
  const logs: string[] = [];
  const take = (node: any) => { for (const line of node?.outcome?.logs ?? []) logs.push(String(line)); };
  take(tx?.transaction_outcome);
  for (const receipt of tx?.receipts_outcome ?? []) take(receipt);
  return logs.filter((line) => line.startsWith('EVENT_JSON:')).map((line) => {
    const parsed = JSON.parse(line.slice('EVENT_JSON:'.length));
    return { event: String(parsed.event), data: Array.isArray(parsed.data) ? parsed.data[0] : parsed.data };
  });
}

/** every receipt must have succeeded: a relayed (meta) transaction reports top-level success even when the
 *  contract call inside it failed, so the top-level status alone is not enough */
export function txOk(tx: any): boolean {
  if (!(tx?.status && typeof tx.status === 'object' && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status))) return false;
  return !(tx?.receipts_outcome ?? []).some((r: any) => r?.outcome?.status && typeof r.outcome.status === 'object' && 'Failure' in r.outcome.status);
}

export function txReturn(tx: any): unknown {
  const value = tx?.status?.SuccessValue;
  if (typeof value !== 'string' || !value) return null;
  const text = new TextDecoder().decode(fromBase64(value));
  try { return JSON.parse(text); } catch { return text; }
}

const PANIC = /treasury_low|paused|not_allowed|bad_wager|bad_pick|no_chips|max_bet|vault_low|dealer_offline|unknown_bet|bad_seed|too_early|already_settled|luck_low|faith_low|cooldown|welcome_claimed|plot_taken|plot_gate|bad_name|bankroll_low|reserve|not_owner|rate_limited|bad_args/;

export function txPanic(tx: any): string | null {
  const failed = (tx?.receipts_outcome ?? []).map((r: any) => r?.outcome?.status).filter((st: any) => st && typeof st === 'object' && 'Failure' in st);
  return JSON.stringify([tx?.status ?? {}, ...failed]).match(PANIC)?.[0] ?? null;
}

/** the protocol-level failure when the contract never ran (e.g. DelegateActionInvalidNonce, NotEnoughBalance) */
export function txFailureName(tx: any): string | null {
  const failed = (tx?.receipts_outcome ?? []).map((r: any) => r?.outcome?.status?.Failure).filter(Boolean);
  const text = JSON.stringify(failed.length ? failed : tx?.status?.Failure ?? tx?.status ?? {});
  const names = [...text.matchAll(/"([A-Z][A-Za-z]+)"\s*:/g)].map((m) => m[1]).filter((n) => !['ActionError', 'TxExecutionError', 'Failure', 'kind', 'FunctionCallError', 'ExecutionError'].includes(n));
  return names[names.length - 1] ?? null;
}
