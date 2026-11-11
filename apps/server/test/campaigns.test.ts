import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, campaignApprovalMessage, campaignClaimMessage, campaignProblem, hexToBytes, keypairFromSecret } from '@cnc/shared';
import { ed25519 } from '@noble/curves/ed25519';
import { buildApp } from '../src/api/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryStore } from '../src/db/memory.ts';
import { Hub } from '../src/indexer/hub.ts';

const seed = new Uint8Array(32).fill(0x42);
const oraclePk = ed25519.getPublicKey(seed);
const player = bytesToHex(keypairFromSecret(new Uint8Array(32).fill(9)).publicKey);
const social = { kind: 0, title: 'Follow @NEARProtocol', url: 'https://x.com/NEARProtocol', machine_id: 0, goal: 0, reward_chips: 2, reward_faith_milli: 3000, max_claims: 50 };

async function harness(campaigns: unknown[] = []) {
  const store = new MemoryStore();
  const app = buildApp({
    config: loadConfig({ ORACLE_SECRET: bytesToHex(seed) }), store, hub: new Hub(), height: async () => 1n, broadcast: async () => 'nope',
    view: async (method) => (method === 'get_campaigns' ? campaigns : null),
  });
  await app.inject({ method: 'POST', url: '/accounts', payload: { public_key: player } });
  return app;
}
const ok = (sig: string, msg: string) => ed25519.verify(hexToBytes(sig), new TextEncoder().encode(msg), oraclePk);

test('the Church rules refuse wallet, airdrop and unknown links', () => {
  assert.equal(campaignProblem(social), null);
  assert.match(campaignProblem({ ...social, url: 'https://evil.example/claim' }) ?? '', /well-known/);
  assert.match(campaignProblem({ ...social, url: 'https://x.com/connect-wallet' }) ?? '', /wallet/);
  assert.match(campaignProblem({ ...social, title: 'Free NEAR airdrop' }) ?? '', /airdrop/);
  assert.match(campaignProblem({ ...social, reward_chips: 0, reward_faith_milli: 0 }) ?? '', /Offer/);
  assert.equal(campaignProblem({ kind: 2, title: 'Play my slot', url: '', machine_id: 1, goal: 5, reward_chips: 3, reward_faith_milli: 0, max_claims: 10 }), null);
});

test('the oracle signs exactly the approved campaign', async () => {
  const app = await harness();
  const r = await app.inject({ method: 'POST', url: '/campaigns/approve', payload: { account_id: player, campaign: social } });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.ok(ok(b.approval, campaignApprovalMessage(player, social, b.expires_ns)));
  assert.ok(!ok(b.approval, campaignApprovalMessage(player, { ...social, reward_chips: 50 }, b.expires_ns)));
  const bad = await app.inject({ method: 'POST', url: '/campaigns/approve', payload: { account_id: player, campaign: { ...social, url: 'https://bit.ly/x' } } });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test('a claim is attested only after the task was opened and the visit time passed', async () => {
  const app = await harness([{ id: 7, kind: 0, active: true, claimed: false }]);
  const early = await app.inject({ method: 'POST', url: '/campaigns/7/attest', payload: { account_id: player } });
  assert.equal(early.json().error, 'not_done');
  await app.inject({ method: 'POST', url: '/campaigns/7/start', payload: { account_id: player } });
  const soon = await app.inject({ method: 'POST', url: '/campaigns/7/attest', payload: { account_id: player } });
  assert.match(soon.json().message, /more seconds/);
  // pretend the player came back 21 s later
  const realNow = Date.now; Date.now = () => realNow() + 21_000;
  try {
    const r = await app.inject({ method: 'POST', url: '/campaigns/7/attest', payload: { account_id: player } });
    assert.equal(r.statusCode, 200);
    assert.ok(ok(r.json().attestation, campaignClaimMessage(7, player, r.json().expires_ns)));
  } finally { Date.now = realNow; }
  await app.close();
});
