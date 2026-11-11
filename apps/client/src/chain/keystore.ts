/**
 * The guest wallet's secret, encrypted at rest.
 *
 * A non-extractable AES-GCM key is created once and kept in IndexedDB (the browser can use it but never reveal its
 * bytes, not even to this page). localStorage holds only the AES-GCM ciphertext of the ed25519 seed. An older
 * plaintext key (`cnc.key.v1`) is encrypted and removed on first load.
 *
 * Where the browser offers no Web Crypto (plain-http LAN addresses are not a "secure context"), it falls back to the
 * old plaintext slot and reports `encrypted: false`, so the UI never claims more than is true.
 */
import { bytesToHex } from '@cnc/shared';

const PLAIN = 'cnc.key.v1';
const SEALED = 'cnc.key.v2';
const DB = 'cnc-vault', STORE = 'keys', WRAP = 'wrap-v1';

const canSeal = () => typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle && globalThis.isSecureContext !== false;

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

async function wrapKey(): Promise<CryptoKey> {
  const have = await idb<CryptoKey | undefined>('readonly', (s) => s.get(WRAP) as IDBRequest<CryptoKey | undefined>);
  if (have) return have;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idb('readwrite', (s) => s.put(key, WRAP));
  return key;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function seal(secret: Uint8Array): Promise<void> {
  const key = await wrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(secret)));
  localStorage.setItem(SEALED, JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
}

async function unseal(): Promise<Uint8Array | null> {
  const raw = localStorage.getItem(SEALED);
  if (!raw) return null;
  const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
  const key = await wrapKey();
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
}

/** this device's guest secret (created on first use); `encrypted` says how it is stored */
export async function loadWalletSecret(parse: (s: string) => Uint8Array): Promise<{ secret: Uint8Array; encrypted: boolean }> {
  if (canSeal()) {
    try {
      const sealed = await unseal();
      if (sealed) return { secret: sealed, encrypted: true };
      const legacy = localStorage.getItem(PLAIN);
      const secret = legacy ? parse(legacy) : crypto.getRandomValues(new Uint8Array(32));
      await seal(secret);
      if (await unseal().then((s) => s && bytesToHex(s) === bytesToHex(secret)).catch(() => false)) localStorage.removeItem(PLAIN);
      else localStorage.setItem(PLAIN, bytesToHex(secret));            // sealing did not round-trip: keep the plain copy
      return { secret, encrypted: !localStorage.getItem(PLAIN) };
    } catch { /* storage blocked or corrupted: fall through to the plain slot */ }
  }
  const existing = localStorage.getItem(PLAIN);
  if (existing) return { secret: parse(existing), encrypted: false };
  const secret = crypto.getRandomValues(new Uint8Array(32));
  localStorage.setItem(PLAIN, bytesToHex(secret));
  return { secret, encrypted: false };
}

/** true if this device already holds a wallet (either slot) */
export const hasWallet = () => !!(localStorage.getItem(SEALED) || localStorage.getItem(PLAIN));

