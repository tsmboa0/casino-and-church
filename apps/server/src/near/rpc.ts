import { createHash } from 'node:crypto';
import { base58Decode, base58Encode, bytesToHex, fromBase64, toBase64 } from '@cnc/shared';

export interface BlockTip {
  height: bigint;
  hash: Uint8Array;
}

/** The default when NEAR_RPC_URL is unset. `rpc.testnet.near.org` is deprecated and answers 429. */
export const DEFAULT_TESTNET_RPC = 'https://near-testnet.drpc.org';

const READ_TIMEOUT_MS = 8_000;
const WAIT_TIMEOUT_MS = 15_000;
const POLL_MS = 300;
const POLL_LIMIT_MS = 30_000;
const TIP_TTL_MS = 15_000;
/** RPC_WAIT=1: let a paid provider hold send_tx until execution (one round trip) instead of polling */
const WAIT_ON_PROVIDER = process.env.RPC_WAIT === '1';

/** Errors worth retrying on another endpoint (transport, rate limit, provider timeout). */
function transient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /rpc (408|429|5\d\d)|aborted|timeout|fetch failed|ECONN|ETIMEDOUT|socket|TIMEOUT_ERROR|free plan/i.test(m);
}

/**
 * JSON-RPC client with:
 *  - several endpoints (NEAR_RPC_URL may be a comma-separated list): a transient failure moves to the next one
 *  - a per-request timeout
 *  - submit-then-poll for transactions: a provider that times out long waits (dRPC's free plan answers 408)
 *    never loses a transaction, because the hash is computed locally and polled
 */
export class NearRpc {
  private urls: string[];
  private active = 0;
  /** when each endpoint last failed: the first (paid) endpoint is retried 30 s after a failure instead of being abandoned */
  private failedAt = new Map<number, number>();
  private tipCache: { at: number; tip: BlockTip } | null = null;

  constructor(url: string, private contract: string) {
    this.urls = url.split(',').map((s) => s.trim()).filter(Boolean);
    if (!this.urls.length) this.urls = [DEFAULT_TESTNET_RPC];
  }

  get endpoint() { return this.urls[this.pick()]!; }
  /** the first endpoint that has not failed in the last 30 s (all failed recently: the one that failed longest ago) */
  private pick(): number {
    const now = Date.now();
    for (let i = 0; i < this.urls.length; i++) if (now - (this.failedAt.get(i) ?? 0) > 30_000) return i;
    let best = 0;
    for (let i = 1; i < this.urls.length; i++) if ((this.failedAt.get(i) ?? 0) < (this.failedAt.get(best) ?? 0)) best = i;
    return best;
  }

  private async once(url: string, method: string, params: unknown, timeoutMs: number): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cnc', method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body = await res.json() as { result?: unknown; error?: { message?: string; name?: string; cause?: unknown; data?: unknown } };
    if (body.error) {
      // keep the cause and data in the message: "Server error" alone hides InvalidNonce, UNKNOWN_TRANSACTION, etc.
      const e = body.error;
      throw new Error(`${e.message ?? 'rpc error'} ${JSON.stringify({ name: e.name, cause: e.cause, data: e.data })}`);
    }
    return body.result;
  }

  async call(method: string, params: unknown, timeoutMs = READ_TIMEOUT_MS): Promise<any> {
    let last: unknown;
    for (let attempt = 0; attempt < Math.max(2, this.urls.length + 1); attempt++) {
      const i = this.pick(), url = this.urls[i]!;
      try {
        return await this.once(url, method, params, timeoutMs);
      } catch (err) {
        last = err;
        if (!transient(err)) throw err;
        this.failedAt.set(i, Date.now());
        this.active = i;
        console.warn(JSON.stringify({ at: 'rpc', host: new URL(url).host, method, attempt, error: err instanceof Error ? err.message.slice(0, 120) : String(err) }));
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  async tip(finality: 'final' | 'optimistic' = 'final'): Promise<BlockTip> {
    const block = await this.call('block', { finality });
    const tip = { height: BigInt(block.header.height), hash: base58Decode(block.header.hash) };
    if (finality === 'final') this.tipCache = { at: Date.now(), tip };
    return tip;
  }

  /** A recent final block hash for signing. Valid for ~24 h on chain, so a 15 s cache only saves a round trip per tx. */
  async recentTip(): Promise<BlockTip> {
    if (this.tipCache && Date.now() - this.tipCache.at < TIP_TTL_MS) return this.tipCache.tip;
    return this.tip('final');
  }

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    const row = await this.call('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
    return BigInt(row.nonce);
  }

  async view(methodName: string, args: unknown, finality: 'final' | 'optimistic' = 'final'): Promise<any> {
    const result = await this.call('query', {
      request_type: 'call_function',
      finality,
      account_id: this.contract,
      method_name: methodName,
      args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args ?? {}))),
    });
    const bytes = Uint8Array.from(result.result as number[]);
    const text = new TextDecoder().decode(bytes);
    return text ? JSON.parse(text) : null;
  }

  async balance(accountId: string): Promise<bigint> {
    const row = await this.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
    return BigInt(row.amount);
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.balance(accountId);
      return true;
    } catch {
      return false;
    }
  }

  /** Hand the transaction to the network and return its hash without waiting for execution. */
  async broadcast(signed: Uint8Array): Promise<string> {
    const hash = txHashOf(signed);
    try {
      await this.call('send_tx', { signed_tx_base64: toBase64(signed), wait_until: 'NONE' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/method (is )?not (available|found)|unknown variant|invalid method|METHOD_NOT_FOUND/i.test(message)) {
        await this.call('broadcast_tx_async', [toBase64(signed)]);
      } else if (!transient(err)) {
        throw err;
      }
      // transient: the tx may well be in the mempool already; the caller polls the hash (and re-sends if unknown)
      if (process.env.DEALER_TIMING === '1') console.log(JSON.stringify({ at: 'send', hash, error: err instanceof Error ? err.message.slice(0, 160) : String(err) }));
    }
    return hash;
  }

  /**
   * Submit and wait for execution. Tries one `send_tx` that waits (fastest on a good RPC); if the provider
   * times out or refuses long waits, polls the locally computed hash and re-sends once if the network never saw it.
   */
  async submitAndWait(signed: Uint8Array, signer: string): Promise<{ hash: string; tx: any }> {
    const hash = txHashOf(signed);
    if (!WAIT_ON_PROVIDER) {
      // default: submit, then poll every 350 ms. Free providers stall or 408 on held-open requests.
      await this.broadcast(signed);
      return { hash, tx: await this.poll(hash, signer, signed) };
    }
    try {
      const result = await this.call('send_tx', { signed_tx_base64: toBase64(signed), wait_until: 'EXECUTED_OPTIMISTIC' }, WAIT_TIMEOUT_MS);
      if (result?.status) return { hash, tx: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/method (is )?not (available|found)|unknown variant|invalid method|METHOD_NOT_FOUND/i.test(message)) {
        await this.call('broadcast_tx_async', [toBase64(signed)]);
      } else if (!transient(err)) {
        throw err;                                    // a real rejection: InvalidNonce, InvalidSignature, Expired...
      }
    }
    return { hash, tx: await this.poll(hash, signer, signed) };
  }

  /** Poll a transaction until it executes. Never blocks on the provider (wait_until NONE). */
  async poll(hash: string, signer: string, resend?: Uint8Array): Promise<any> {
    const start = Date.now();
    let lastSend = start;
    let last: unknown = null;
    while (Date.now() - start < POLL_LIMIT_MS) {
      try {
        const tx = await this.call('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' });
        const stage = String(tx?.final_execution_status ?? '');
        const pending = stage === 'NONE' || stage === 'INCLUDED' || stage === 'INCLUDED_FINAL';
        if (!pending && tx?.status && typeof tx.status === 'object' && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status || 'Failure' in tx.status)) return tx;
        last = tx;
      } catch (err) {
        last = err;
        // the network has not seen it: a provider sometimes drops a submission. The same signed bytes have the
        // same hash, so sending again is idempotent; do it every 2 s until it shows up.
        const unknown = /UNKNOWN_TRANSACTION|doesn't exist|does not exist|not found/i.test(err instanceof Error ? err.message : String(err));
        if (unknown && resend && Date.now() - lastSend > 2_000) {
          lastSend = Date.now();
          try { await this.call('send_tx', { signed_tx_base64: toBase64(resend), wait_until: 'NONE' }); }
          catch (e) { if (process.env.DEALER_TIMING === '1') console.log(JSON.stringify({ at: 'resend', hash, error: e instanceof Error ? e.message.slice(0, 160) : String(e) })); }
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw last instanceof Error ? last : new Error('tx timeout');
  }

  async tx(hash: string, signer: string): Promise<any> {
    return this.poll(hash, signer);
  }
}

export function txLogs(tx: any): string[] {
  const out: string[] = [];
  const take = (node: any) => {
    for (const line of node?.outcome?.logs ?? []) out.push(String(line));
  };
  take(tx?.transaction_outcome);
  for (const receipt of tx?.receipts_outcome ?? []) take(receipt);
  return out;
}

export function eventsOf(tx: any): { event: string; data: any }[] {
  const found = [];
  for (const line of txLogs(tx)) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    const parsed = JSON.parse(line.slice('EVENT_JSON:'.length));
    const data = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
    found.push({ event: String(parsed.event), data });
  }
  return found;
}

export function panicCode(tx: any): string | null {
  const text = JSON.stringify(tx?.status ?? tx);
  const known = text.match(/paused|not_allowed|bad_wager|bad_pick|no_chips|max_bet|vault_low|dealer_offline|unknown_bet|bad_seed|too_early|already_settled|luck_low|faith_low|cooldown|welcome_claimed|plot_taken|plot_gate|bad_name|bankroll_low|reserve|not_owner|rate_limited|treasury_low|bad_args/);
  return known?.[0] ?? null;
}

export function txSucceeded(tx: any): boolean {
  const status = tx?.status;
  if (!status || typeof status !== 'object') return false;
  if ('Failure' in status || 'failure' in (status ?? {})) return false;
  // a batched tx (e.g. record_decision + action) fails if ANY receipt failed
  for (const r of tx?.receipts_outcome ?? []) if (r?.outcome?.status && 'Failure' in r.outcome.status) return false;
  return 'SuccessValue' in status || 'SuccessReceiptId' in status;
}

export function successBytes(tx: any): Uint8Array | null {
  const value = tx?.status?.SuccessValue;
  if (typeof value !== 'string' || value.length === 0) return null;
  return fromBase64(value);
}

export { bytesToHex };

/** NEAR tx hash = base58(sha256(borsh(Transaction))); the signed tx is borsh(Transaction) followed by a 65-byte signature (1 key-type byte + 64). */
export function txHashOf(signed: Uint8Array): string {
  const body = signed.subarray(0, signed.length - 65);
  return base58Encode(createHash('sha256').update(body).digest());
}
