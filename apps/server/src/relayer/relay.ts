import {
  MAX_RELAY_GAS, RELAY_ALLOWLIST, TGAS, bytesToHex, decodeSignedDelegate, humanError, verifyDelegate,
  type SignedDelegate,
} from '@cnc/shared';
import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { HttpError } from '../http.ts';

const ALLOWED = new Set<string>(RELAY_ALLOWLIST);

function bucket(kind: 'h' | 'd', now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  if (kind === 'd') return `d:${y}${m}${d}`;
  const h = String(now.getUTCHours()).padStart(2, '0');
  return `h:${y}${m}${d}${h}`;
}

/** accounts are never deleted, so a positive lookup can be cached for the life of the process */
const known = new Set<string>();
async function knownAccount(store: Store, id: string): Promise<boolean> {
  if (known.has(id)) return true;
  const row = await store.account(id);
  if (row) known.add(id);
  return Boolean(row);
}
/** the pace check must hold even before the (async) quota write lands */
const lastBetAt = new Map<string, number>();

export async function acceptRelay(opts: {
  config: Config;
  store: Store;
  body: string;
  ip: string;
  height: bigint;
  broadcast: (signed: SignedDelegate) => Promise<string>;
  /** tests: wait for the quota writes before answering (production answers first) */
  awaitWrites?: boolean;
  /** called after a successful broadcast: what the hosts can observe of the floor */
  observe?: (sender: string, method: string, args: unknown) => void;
}): Promise<{ tx_hash: string }> {
  const { config, store } = opts;
  if (config.relayDisabled) throw new HttpError(503, 'paused', 'The relayer is paused.');
  if (!config.contract) throw new HttpError(503, 'dealer_offline', 'The contract is not configured.');
  let signed: SignedDelegate;
  try {
    signed = decodeSignedDelegate(Buffer.from(opts.body, 'base64'));
  } catch {
    throw new HttpError(400, 'bad_args', 'The signed delegate could not be read.');
  }
  if (!verifyDelegate(signed)) throw new HttpError(400, 'bad_args', 'The signature does not match the key.');
  const action = signed.delegate.actions[0];
  if (!action) throw new HttpError(400, 'bad_args', 'Missing action.');
  const sender = signed.delegate.senderId;
  if (bytesToHex(signed.delegate.publicKey) !== sender) {
    throw new HttpError(400, 'bad_args', 'The key does not match the implicit account.');
  }
  if (signed.delegate.receiverId !== config.contract) throw new HttpError(400, 'not_allowed', 'Wrong receiver.');
  if (!ALLOWED.has(action.methodName)) throw new HttpError(400, 'not_allowed', 'That method is not relayed.');
  if (action.deposit !== 0n) throw new HttpError(400, 'not_allowed', 'A relayed call cannot attach a deposit.');
  if (action.gas <= 0n || action.gas > MAX_RELAY_GAS) throw new HttpError(400, 'bad_args', 'Gas is outside the relayer cap.');
  const maxH = signed.delegate.maxBlockHeight;
  if (maxH < opts.height || maxH > opts.height + 100n) throw new HttpError(400, 'bad_args', 'The delegate expired.');
  // All reads in ONE round of parallel queries: the database may be a network hop away (each query ~100-200 ms).
  const hour = bucket('h');
  const day = bucket('d');
  const [deniedAccount, deniedIp, known, accountHour, accountDay, ipHour, globalDay, pace] = await Promise.all([
    store.denied('account', sender), store.denied('ip', opts.ip), knownAccount(store, sender),
    store.quota('account', sender, hour), store.quota('account', sender, day), store.quota('ip', opts.ip, hour),
    store.quota('global', 'relay', day),
    action.methodName === 'place_bet' ? store.quota('pace', sender, 'last') : Promise.resolve({ count: 0, gasTgas: 0 }),
  ]);
  if (deniedAccount || deniedIp) throw new HttpError(403, 'not_allowed', 'This account is blocked.');
  if (!known) throw new HttpError(403, 'unknown_account', humanError('unknown_account'));
  if (accountHour.count >= config.accountHour || accountDay.count >= config.accountDay || ipHour.count >= config.ipHour) {
    throw new HttpError(429, 'quota', humanError('quota'), 60);
  }
  const gasTgas = Number(action.gas / TGAS);
  if (globalDay.gasTgas + gasTgas > config.dailyGasTgas) throw new HttpError(429, 'quota', 'The relayer gas budget is spent for today.', 60);
  if (action.methodName === 'place_bet') {
    const last = Math.max(pace.count, lastBetAt.get(sender) ?? 0);
    if (last && Date.now() - last < config.placeBetMs) throw new HttpError(429, 'rate_limited', humanError('rate_limited'), 1);
  }

  let txHash: string;
  try {
    txHash = await opts.broadcast(signed);
  } catch {
    await store.addQuota('errors', 'relay', hour, 1, 0);
    throw new HttpError(503, 'dealer_offline', 'The relayer could not broadcast.');
  }
  // Count it only after a successful broadcast, and do not make the player wait for the writes.
  if (action.methodName === 'place_bet') lastBetAt.set(sender, Date.now());
  const writes = Promise.all([
    store.addQuota('account', sender, hour, 1, 0),
    store.addQuota('account', sender, day, 1, 0),
    store.addQuota('ip', opts.ip, hour, 1, 0),
    store.addQuota('global', 'relay', day, 1, gasTgas),
    action.methodName === 'place_bet' ? store.setQuota('pace', sender, 'last', Date.now(), 0) : Promise.resolve(),
  ]).catch((err) => console.error(JSON.stringify({ at: 'relay', error: `quota write: ${err instanceof Error ? err.message : err}` })));
  if (opts.awaitWrites) await writes;
  if (opts.observe) {
    let args: unknown = {};
    try { args = JSON.parse(new TextDecoder().decode(action.args)); } catch { /* not JSON */ }
    opts.observe(sender, action.methodName, args);
  }
  return { tx_hash: txHash };
}
