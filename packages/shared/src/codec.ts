/**
 * NEP-366 delegate actions and the transaction that wraps one.
 * Hash prefix is NEP-461: sha256( le_u32(2^30 + 366) || borsh(DelegateAction) ).
 * Action tags match near-primitives 0.35: FunctionCall = 2, Delegate = 8.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { Reader, Writer } from './borsh.ts';

export const NEP461_DISCRIMINANT = (1 << 30) + 366;
export const ACTION_FUNCTION_CALL = 2;
export const ACTION_TRANSFER = 3;
export const ACTION_DELEGATE = 8;
export const TGAS = 1_000_000_000_000n;
/** A blackjack deal attaches 80 TGas (it reserves 18 seeds); leave headroom. */
export const MAX_RELAY_GAS = 100n * TGAS;
export const YOCTO = 10n ** 24n;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return '1'.repeat(zeros) + (s || (zeros ? '' : ''));
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (n > 0n) { body.push(Number(n & 255n)); n >>= 8n; }
  body.reverse();
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function publicKeyString(raw: Uint8Array): string {
  return `ed25519:${base58Encode(raw)}`;
}

/** near-cli secret (`ed25519:` + base58 of 32-byte seed or 64-byte seed||pubkey) or 64 hex. */
export function parseSecret(text: string): Uint8Array {
  const raw = text.startsWith('ed25519:') ? base58Decode(text.slice('ed25519:'.length)) : hexToBytes(text);
  if (raw.length === 32) return raw;
  if (raw.length === 64) return raw.slice(0, 32);
  throw new Error('secret key must be 32 or 64 bytes');
}

export function keypairFromSecret(secret: Uint8Array): { secret: Uint8Array; publicKey: Uint8Array } {
  return { secret, publicKey: ed25519.getPublicKey(secret) };
}

export interface FunctionCallAction {
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}

export interface DelegateAction {
  senderId: string;
  receiverId: string;
  actions: FunctionCallAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: Uint8Array;
}

function writeFunctionCall(w: Writer, a: FunctionCallAction) {
  w.u8(ACTION_FUNCTION_CALL);
  w.str(a.methodName);
  w.bytes(a.args);
  w.u64(a.gas);
  w.u128(a.deposit);
}

export function encodeDelegateAction(a: DelegateAction): Uint8Array {
  const w = new Writer();
  w.str(a.senderId);
  w.str(a.receiverId);
  w.u32(a.actions.length);
  for (const action of a.actions) writeFunctionCall(w, action);
  w.u64(a.nonce);
  w.u64(a.maxBlockHeight);
  w.u8(0);
  w.raw(a.publicKey);
  return w.finish();
}

export function nep461Hash(delegate: DelegateAction): Uint8Array {
  const w = new Writer();
  w.u32(NEP461_DISCRIMINANT);
  w.raw(encodeDelegateAction(delegate));
  return sha256(w.finish());
}

export interface SignedDelegate {
  delegate: DelegateAction;
  signature: Uint8Array;
}

export function signDelegate(secret: Uint8Array, delegate: DelegateAction): SignedDelegate {
  const signature = ed25519.sign(nep461Hash(delegate), secret);
  return { delegate, signature };
}

export function encodeSignedDelegate(s: SignedDelegate): Uint8Array {
  const w = new Writer();
  w.raw(encodeDelegateAction(s.delegate));
  w.u8(0);
  w.raw(s.signature);
  return w.finish();
}

export function decodeSignedDelegate(buf: Uint8Array): SignedDelegate {
  const r = new Reader(buf);
  const senderId = r.str();
  const receiverId = r.str();
  const n = r.u32();
  if (n !== 1) throw new Error('exactly one action');
  const tag = r.u8();
  if (tag !== ACTION_FUNCTION_CALL) throw new Error('not a function call');
  const methodName = r.str();
  const args = r.bytes();
  const gas = r.u64();
  const deposit = r.u128();
  const nonce = r.u64();
  const maxBlockHeight = r.u64();
  const keyType = r.u8();
  if (keyType !== 0) throw new Error('only ed25519');
  const publicKey = r.raw(32);
  const sigType = r.u8();
  if (sigType !== 0) throw new Error('only ed25519');
  const signature = r.raw(64);
  if (r.rest !== 0) throw new Error('trailing bytes');
  return {
    delegate: { senderId, receiverId, actions: [{ methodName, args, gas, deposit }], nonce, maxBlockHeight, publicKey },
    signature,
  };
}

export function verifyDelegate(s: SignedDelegate): boolean {
  return ed25519.verify(s.signature, nep461Hash(s.delegate), s.delegate.publicKey);
}

export interface Transaction {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: Uint8Array;
}

export function encodeTransaction(tx: Transaction): Uint8Array {
  const w = new Writer();
  w.str(tx.signerId);
  w.u8(0);
  w.raw(tx.publicKey);
  w.u64(tx.nonce);
  w.str(tx.receiverId);
  w.raw(tx.blockHash);
  w.raw(tx.actions);
  return w.finish();
}

export function delegateActionBytes(signed: SignedDelegate): Uint8Array {
  const w = new Writer();
  w.u32(1);
  w.u8(ACTION_DELEGATE);
  w.raw(encodeSignedDelegate(signed));
  return w.finish();
}

export function transferActionBytes(yocto: bigint): Uint8Array {
  const w = new Writer();
  w.u32(1);
  w.u8(ACTION_TRANSFER);
  w.u128(yocto);
  return w.finish();
}

export function signTransaction(secret: Uint8Array, tx: Transaction): Uint8Array {
  const body = encodeTransaction(tx);
  const sig = ed25519.sign(sha256(body), secret);
  const w = new Writer();
  w.raw(body);
  w.u8(0);
  w.raw(sig);
  return w.finish();
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Hard-coded near-primitives delegate fixture: CreateAccount inside a delegate, empty key and signature. */
export function emptyDelegateFixture(): Uint8Array {
  const w = new Writer();
  w.u8(ACTION_DELEGATE);
  w.str('aaa');
  w.str('bbb');
  w.u32(1);
  w.u8(0);
  w.u64(1n);
  w.u64(2n);
  w.u8(0);
  w.raw(new Uint8Array(32));
  w.u8(0);
  w.raw(new Uint8Array(64));
  return w.finish();
}
