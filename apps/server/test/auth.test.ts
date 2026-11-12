import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { AUTH_KDF_ITERATIONS, bytesToHex, keypairFromSecret, signupMessage } from '@cnc/shared';
import { ed25519 } from '@noble/curves/ed25519';
import { buildApp } from '../src/api/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/db/memory.ts';
import { Hub } from '../src/indexer/hub.ts';

// the device side, as the client does it (PBKDF2 -> encryption half + auth half; AES-GCM over the 32-byte seed)
const derive = (pw: string, saltHex: string) => {
  const bits = pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), AUTH_KDF_ITERATIONS, 64, 'sha256');
  return { enc: bits.subarray(0, 32), auth: bits.subarray(32).toString('hex') };
};
const seal = (key: Buffer, seed: Uint8Array) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(seed), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('hex'), ct: ct.toString('hex') };
};
const open = (key: Buffer, ivHex: string, ctHex: string) => {
  const ct = Buffer.from(ctHex, 'hex'); const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  d.setAuthTag(ct.subarray(ct.length - 16)); return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
};

async function harness() {
  const store = new MemoryStore();
  const app = buildApp({ config: loadConfig({}), store, hub: new Hub(), height: async () => 1n, broadcast: async () => 'nope' });
  const seed = randomBytes(32); const accountId = bytesToHex(keypairFromSecret(seed).publicKey);
  await app.inject({ method: 'POST', url: '/accounts', payload: { public_key: accountId } });
  const signup = (name: string, pw: string, signWith = seed) => {
    const salt = randomBytes(16).toString('hex'); const k = derive(pw, salt); const w = seal(k.enc, seed); const ts = Date.now();
    const signature = bytesToHex(ed25519.sign(new TextEncoder().encode(signupMessage(accountId, name, salt, ts)), signWith));
    return app.inject({ method: 'POST', url: '/auth/signup', payload: { username: name, account_id: accountId, salt, iterations: AUTH_KDF_ITERATIONS, auth_key: k.auth, wallet_iv: w.iv, wallet_ct: w.ct, ts, signature } });
  };
  const login = async (name: string, pw: string) => {
    const s = await app.inject({ method: 'GET', url: `/auth/salt?username=${encodeURIComponent(name)}` });
    if (s.statusCode !== 200) return { status: s.statusCode, body: s.json() };
    const k = derive(pw, s.json().salt);
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: name, auth_key: k.auth } });
    return { status: r.statusCode, body: r.json(), enc: k.enc };
  };
  return { app, seed, accountId, signup, login };
}

test('create an account, then sign in from a "new device" and decrypt the same wallet', async () => {
  const h = await harness();
  const r = await h.signup('Magpie77', 'correct horse battery');
  assert.equal(r.statusCode, 200);
  const l = await h.login('magpie 77', 'correct horse battery');            // any spelling of the name
  assert.equal(l.status, 200);
  assert.equal(l.body.account_id, h.accountId);
  const seed = open(l.enc!, l.body.wallet_iv, l.body.wallet_ct);
  assert.equal(bytesToHex(seed), bytesToHex(h.seed));                      // the device recovers the exact wallet key
  await h.app.close();
});

test('a wrong password learns nothing, and repeated guesses are locked out', async () => {
  const h = await harness();
  await h.signup('Raven', 'correct horse battery');
  const bad = await h.login('Raven', 'wrong password!!');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.wallet_ct, undefined);                              // no sealed wallet without the right key
  for (let i = 0; i < 9; i++) await h.login('Raven', 'still wrong ' + i);
  const locked = await h.login('Raven', 'correct horse battery');
  assert.equal(locked.status, 429);
  assert.equal((await h.login('Nobody', 'whatever whatever')).status, 404);
  await h.app.close();
});

test('only the wallet itself can secure itself, once, under a free name', async () => {
  const h = await harness();
  const forged = await h.signup('Sparrow', 'correct horse battery', randomBytes(32));
  assert.equal(forged.statusCode, 401);
  assert.equal((await h.signup('Sparrow', 'correct horse battery')).statusCode, 200);
  assert.equal((await h.signup('Sparrow2', 'correct horse battery')).statusCode, 409);   // this wallet is already secured
  await h.app.close();
});
