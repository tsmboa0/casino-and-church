/**
 * The device side of username + password accounts (see packages/shared/src/auth.ts).
 *
 * PBKDF2-SHA256(password, salt, 600 000 rounds) -> 64 bytes:
 *   bytes  0..31  ENCRYPTION key: AES-GCM over the wallet's 32-byte ed25519 seed. Never leaves this device.
 *   bytes 32..63  AUTH key: sent at sign-in; the server stores only its SHA-256 and returns the sealed seed for it.
 * The server therefore never sees the password and can never open the sealed seed.
 */
import { AUTH_KDF_ITERATIONS, bytesToHex, hexToBytes } from '@cnc/shared';
import { BackendError } from '../core/errors';

export interface DerivedKeys { enc: CryptoKey; authHex: string }

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle || globalThis.isSecureContext === false) {
    throw new BackendError('insecure', 'Accounts need a secure connection. Open the game at https://casino-and-church.vercel.app');
  }
  return crypto.subtle;
}
const buf = (u: Uint8Array) => new Uint8Array(u).buffer as ArrayBuffer;

export function newSaltHex(): string { return bytesToHex(crypto.getRandomValues(new Uint8Array(16))); }

export async function deriveKeys(password: string, saltHex: string, iterations = AUTH_KDF_ITERATIONS): Promise<DerivedKeys> {
  const s = subtle();
  const base = await s.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(hexToBytes(saltHex)), iterations }, base, 512));
  const enc = await s.importKey('raw', buf(bits.slice(0, 32)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { enc, authHex: bytesToHex(bits.slice(32)) };
}

/** seal the 32-byte seed: 12-byte IV, 48-byte ciphertext (seed + GCM tag), both hex */
export async function sealSeed(enc: CryptoKey, seed: Uint8Array): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, enc, buf(seed)));
  return { iv: bytesToHex(iv), ct: bytesToHex(ct) };
}

export async function openSeed(enc: CryptoKey, ivHex: string, ctHex: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(hexToBytes(ivHex)) }, enc, buf(hexToBytes(ctHex))));
  } catch {
    throw new BackendError('bad_login', 'Wrong username or password.');
  }
}
