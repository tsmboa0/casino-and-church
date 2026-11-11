import {
  ACTION_FUNCTION_CALL, Writer, base58Encode, bytesToHex, encodeSignedDelegate, keypairFromSecret,
  parseSecret, publicKeyString, signDelegate, signTransaction, type FunctionCallAction,
} from '@cnc/shared';
import { accessNonce, blockTip, broadcast } from './rpc';
import { BackendError } from '../core/errors';
import { loadWalletSecret } from './keystore';


export interface Session {
  accountId: string;
  secret: Uint8Array;
  publicKey: Uint8Array;
  exportKey: () => string;
  signDelegate: (action: Omit<FunctionCallAction, 'deposit'> & { receiverId: string; maxBlockHeight: bigint }) => Promise<Uint8Array>;
  signAndSend: (action: FunctionCallAction & { receiverId: string }) => Promise<string>;
}

let pending: Promise<Session> | null = null;
let nonce = 0n;
/** false until the key's nonce was read from the chain. A brand-new implicit account does not exist yet when the
 *  session opens, and NEAR starts a new key's nonce at (block height x 10^6), not at 1. */
let nonceKnown = false;
let reread: (() => Promise<void>) | null = null;
/** call after a nonce failure: the next signature re-reads the nonce from the chain */
export async function refreshNonce() { nonceKnown = false; if (reread) await reread(); }

/** the open session's secret (decrypted in memory only) */
let current: Uint8Array | null = null;
/** how this device stores the wallet: encrypted at rest, or the plain fallback */
export const wallet = { accountId: '', encrypted: false };

export function exportKey(): string {
  if (!current) return '';
  const secret = current;
  const { publicKey } = keypairFromSecret(secret);
  const full = new Uint8Array(64);
  full.set(secret, 0);
  full.set(publicKey, 32);
  return `ed25519:${base58Encode(full)}`;
}

/** One guest session per tab. A failed open is not cached, so the next action retries it. */
export function getSession(api: string): Promise<Session> {
  pending ??= open(api).catch((err) => { pending = null; throw err; });
  return pending;
}

async function open(api: string): Promise<Session> {
  const { secret, encrypted } = await loadWalletSecret(parseSecret);
  current = secret;
  const { publicKey } = keypairFromSecret(secret);
  const accountId = bytesToHex(publicKey);
  wallet.accountId = accountId; wallet.encrypted = encrypted;
  const res = await fetch(`${api}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: accountId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new BackendError(String(body.error || 'account'), body.message || 'Could not create the guest account.');
  }
  const pk = publicKeyString(publicKey);
  const readNonce = async () => {
    try { nonce = (await accessNonce(accountId, pk)) + 1n; nonceKnown = true; }
    catch { if (!nonceKnown) nonce = 1n; }
  };
  reread = readNonce;
  await readNonce();
  // the account lands a block or two after the funding transfer: wait for its key so the first action signs right.
  // If it never shows up (a dropped funding transaction), ask again: the server re-funds a known but missing account.
  for (let round = 0; round < 2 && !nonceKnown; round++) {
    if (round) await fetch(`${api}/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ public_key: accountId }) }).catch(() => {});
    for (let i = 0; i < 14 && !nonceKnown; i++) { await new Promise((r) => setTimeout(r, 500)); await readNonce(); }
  }
  if (!nonceKnown) throw new BackendError('account', 'Your guest account is still being created');

  const session: Session = {
    accountId,
    secret,
    publicKey,
    exportKey,
    signDelegate: async (action) => {
      if (!nonceKnown) await readNonce();
      const signed = signDelegate(secret, {
        senderId: accountId,
        receiverId: action.receiverId,
        actions: [{ methodName: action.methodName, args: action.args, gas: action.gas, deposit: 0n }],
        nonce,
        maxBlockHeight: action.maxBlockHeight,
        publicKey,
      });
      nonce += 1n;
      return encodeSignedDelegate(signed);
    },
    signAndSend: async (action) => {
      if (!nonceKnown) await readNonce();
      const tip = await blockTip();
      const w = new Writer();
      w.u32(1);
      w.u8(ACTION_FUNCTION_CALL);
      w.str(action.methodName);
      w.bytes(action.args);
      w.u64(action.gas);
      w.u128(action.deposit);
      const tx = signTransaction(secret, {
        signerId: accountId, publicKey, nonce, receiverId: action.receiverId, blockHash: tip.hash, actions: w.finish(),
      });
      nonce += 1n;
      return broadcast(tx);
    },
  };
  (window as unknown as { cncExportKey?: () => string }).cncExportKey = exportKey;
  return session;
}

export function resetNonce() { nonce = 0n; pending = null; }
