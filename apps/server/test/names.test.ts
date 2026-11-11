import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, keypairFromSecret, nameClaimMessage, nameKey, nameProblem } from '@cnc/shared';
import { ed25519 } from '@noble/curves/ed25519';
import { buildApp } from '../src/api/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/db/memory.ts';
import { Hub } from '../src/indexer/hub.ts';

const player = (fill: number) => {
  const secret = new Uint8Array(32).fill(fill);
  const { publicKey } = keypairFromSecret(secret);
  return { secret, accountId: bytesToHex(publicKey) };
};
const claim = (p: { secret: Uint8Array; accountId: string }, name: string, ts = Date.now()) => ({
  account_id: p.accountId, name, ts, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(nameClaimMessage(p.accountId, name, ts)), p.secret)),
});
async function harness() {
  const store = new MemoryStore();
  const app = buildApp({ config: loadConfig({}), store, hub: new Hub(), height: async () => 1n, broadcast: async () => 'nope' });
  const a = player(7), b = player(8);
  for (const p of [a, b]) await app.inject({ method: 'POST', url: '/accounts', payload: { public_key: p.accountId } });
  return { app, a, b };
}

test('name rules match the contract and ignore case and separators for uniqueness', () => {
  assert.equal(nameProblem('Magpie77'), null);
  assert.equal(nameProblem("O'Neil-Luck"), null);
  assert.ok(nameProblem('ab'));                       // contract minimum is 3
  assert.ok(nameProblem('a'.repeat(17)));
  assert.ok(nameProblem('bad!name'));
  assert.ok(nameProblem('Father Nakamoto'));          // reserved
  assert.equal(nameKey('Magpie 77'), nameKey('magpie_77'));
});

test('a signed claim takes a name; the same name in another spelling is then taken', async () => {
  const { app, a, b } = await harness();
  assert.equal((await app.inject({ method: 'GET', url: '/names/check?name=Magpie77' })).json().available, true);
  const ok = await app.inject({ method: 'POST', url: '/names', payload: claim(a, 'Magpie77') });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/names/check?name=magpie%2077&account=${b.accountId}` })).json().available, false);
  assert.equal((await app.inject({ method: 'GET', url: `/names/check?name=Magpie77&account=${a.accountId}` })).json().available, true);   // yours
  const taken = await app.inject({ method: 'POST', url: '/names', payload: claim(b, 'magpie_77') });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().error, 'name_taken');
  await app.close();
});

test('nobody can claim a name for someone else, and changing your name frees the old one', async () => {
  const { app, a, b } = await harness();
  const forged = { ...claim(b, 'Raven'), account_id: a.accountId };    // b's signature, a's account
  assert.equal((await app.inject({ method: 'POST', url: '/names', payload: forged })).statusCode, 401);
  const stale = claim(a, 'Raven', Date.now() - 10 * 60_000);
  assert.equal((await app.inject({ method: 'POST', url: '/names', payload: stale })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/names', payload: claim(a, 'Raven') })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/names', payload: claim(a, 'Sparrow') })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/names', payload: claim(b, 'Raven') })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/names/${a.accountId}` })).json().name, 'Sparrow');
  await app.close();
});
