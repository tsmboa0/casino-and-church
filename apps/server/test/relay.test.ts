import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TGAS, bytesToHex, encodeSignedDelegate, keypairFromSecret, signDelegate, toBase64,
} from '@cnc/shared';
import { buildApp } from '../src/api/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/db/memory.ts';
import { Hub } from '../src/indexer/hub.ts';

const secret = new Uint8Array(32).fill(4);
const { publicKey } = keypairFromSecret(secret);
const accountId = bytesToHex(publicKey);

function signed(opts: { method?: string; deposit?: bigint; gas?: bigint; receiver?: string; max?: bigint; sender?: string }) {
  const delegate = signDelegate(secret, {
    senderId: opts.sender ?? accountId,
    receiverId: opts.receiver ?? 'realm.testnet',
    actions: [{
      methodName: opts.method ?? 'place_bet',
      args: new TextEncoder().encode('{}'),
      gas: opts.gas ?? 30n * TGAS,
      deposit: opts.deposit ?? 0n,
    }],
    nonce: 1n,
    maxBlockHeight: opts.max ?? 1050n,
    publicKey,
  });
  return toBase64(encodeSignedDelegate(delegate));
}

async function harness() {
  const store = new MemoryStore();
  await store.insertAccount({ accountId, publicKey: accountId, ip: '127.0.0.1', createdAt: Date.now() });
  let submits = 0;
  const app = buildApp({
    config: loadConfig({ REALM_CONTRACT: 'realm.testnet', CLIENT_ORIGIN: 'http://localhost:5173' }),
    store,
    hub: new Hub(),
    height: async () => 1000n,
    broadcast: async () => { submits++; return 'txhash'; },
  });
  return { app, store, submits: () => submits };
}

async function relay(app: any, body: string) {
  const res = await app.inject({ method: 'POST', url: '/relay', payload: { signed_delegate: body } });
  return { status: res.statusCode, body: res.json() as { error?: string; tx_hash?: string }, headers: res.headers };
}

test('relayer rejects deposit, receiver, method, stranger, height, and quota', async () => {
  const { app, store } = await harness();
  assert.equal((await relay(app, signed({ deposit: 1n }))).status, 400);
  assert.equal((await relay(app, signed({ receiver: 'other.testnet' }))).body.error, 'not_allowed');
  assert.equal((await relay(app, signed({ method: 'reveal' }))).body.error, 'not_allowed');
  assert.equal((await relay(app, signed({ sender: 'f'.repeat(64) }))).status, 400);
  assert.equal((await relay(app, signed({ max: 2000n }))).status, 400);
  const stranger = new Uint8Array(32).fill(9);
  const other = keypairFromSecret(stranger);
  const foreign = signDelegate(stranger, {
    senderId: bytesToHex(other.publicKey),
    receiverId: 'realm.testnet',
    actions: [{ methodName: 'withdraw', args: new Uint8Array(), gas: 30n * TGAS, deposit: 0n }],
    nonce: 1n, maxBlockHeight: 1050n, publicKey: other.publicKey,
  });
  const unknown = await relay(app, toBase64(encodeSignedDelegate(foreign)));
  assert.equal(unknown.body.error, 'unknown_account');

  const ok = await relay(app, signed({}));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tx_hash, 'txhash');
  const paced = await relay(app, signed({}));
  assert.equal(paced.status, 429);
  assert.equal(paced.headers['retry-after'], '1');

  await store.addQuota('account', accountId, bucketHour(), 120, 0);
  const capped = await relay(app, signed({ method: 'withdraw' }));
  assert.equal(capped.status, 429);
  await app.close();
});

test('accounts endpoint records an implicit account', async () => {
  const store = new MemoryStore();
  const app = buildApp({
    config: loadConfig({}),
    store, hub: new Hub(), height: async () => 1n, broadcast: async () => 'nope',
  });
  const res = await app.inject({ method: 'POST', url: '/accounts', payload: { public_key: accountId } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().account_id, accountId);
  assert.ok(await store.account(accountId));
  await app.close();
});

test('a failed broadcast does not burn the hourly quota', async () => {
  const store = new MemoryStore();
  await store.insertAccount({ accountId, publicKey: accountId, ip: '127.0.0.1', createdAt: Date.now() });
  const app = buildApp({
    config: loadConfig({ REALM_CONTRACT: 'realm.testnet', CLIENT_ORIGIN: 'http://localhost:5173' }),
    store, hub: new Hub(), height: async () => 1000n,
    broadcast: async () => { throw new Error('rpc down'); },
  });
  const res = await app.inject({ method: 'POST', url: '/relay', payload: { signed_delegate: signed({ method: 'withdraw' }) } });
  assert.equal(res.statusCode, 503);
  const used = await store.quota('account', accountId, bucketHour());
  assert.equal(used.count, 0);
  await app.close();
});

function bucketHour() {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `h:${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}`;
}
