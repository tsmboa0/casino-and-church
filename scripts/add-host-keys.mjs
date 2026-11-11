#!/usr/bin/env node
/**
 * Adds the hosts' function-call keys (AGENT_KEYS on DEALER_ACCOUNT, PRIEST_KEYS on PRIEST_ACCOUNT) on chain,
 * signing with each account's full-access owner key from .env.local (BOSS_OWNER_SECRET, PRIEST_OWNER_SECRET).
 * Same permissions as scripts/host-keys.mjs prints for near-cli. Skips keys already on the account. Prints no secret.
 *
 *   apps/server/node_modules/.bin/tsx scripts/add-host-keys.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const shared = await import('../packages/shared/src/index.ts');
const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const rpcUrl = (get('NEAR_RPC_URL') || 'https://near-testnet.drpc.org').split(',')[0].trim();
const contract = get('REALM_CONTRACT');
const HOSTS = [
  { keys: 'AGENT_KEYS', owner: 'BOSS_OWNER_SECRET', account: get('DEALER_ACCOUNT'), methods: ['host_act', 'set_params', 'start_event', 'end_event', 'top_up_jackpot'] },
  { keys: 'PRIEST_KEYS', owner: 'PRIEST_OWNER_SECRET', account: get('PRIEST_ACCOUNT'), methods: ['host_act', 'start_event', 'end_event', 'grant_alms', 'set_church_params'] },
];
const ALLOWANCE = 10n ** 24n; // 1 NEAR of gas per key

for (const h of HOSTS) {
  const secrets = get(h.keys).split(',').filter(Boolean);
  if (!secrets.length) { console.log(`${h.account}: no ${h.keys} in .env.local (run scripts/host-keys.mjs)`); continue; }
  if (!get(h.owner)) { console.log(`${h.account}: no ${h.owner} in .env.local; add the keys with the near-cli commands from host-keys.mjs instead`); continue; }
  const owner = shared.parseSecret(get(h.owner));
  const ownerPk = shared.keypairFromSecret(owner).publicKey;
  const onChain = new Set((await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: h.account })).keys.map((k) => k.public_key));
  const todo = secrets.map((s) => shared.keypairFromSecret(shared.parseSecret(s)).publicKey).filter((pk) => !onChain.has(shared.publicKeyString(pk)));
  if (!todo.length) { console.log(`${h.account}: keys already on chain`); continue; }
  const w = new shared.Writer();
  w.u32(todo.length);
  for (const pk of todo) {
    w.u8(5);                       // AddKey
    w.u8(0); w.raw(pk);            // PublicKey ed25519
    w.u64(0n);                     // AccessKey.nonce
    w.u8(0);                       // FunctionCall permission
    w.u8(1); w.u128(ALLOWANCE);    // allowance: Some
    w.str(contract);
    w.u32(h.methods.length); for (const m of h.methods) w.str(m);
  }
  const access = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: h.account, public_key: shared.publicKeyString(ownerPk) });
  const block = await rpc('block', { finality: 'final' });
  const signed = shared.signTransaction(owner, {
    signerId: h.account, publicKey: ownerPk, nonce: BigInt(access.nonce) + 1n, receiverId: h.account,
    blockHash: shared.base58Decode(block.header.hash), actions: w.finish(),
  });
  const hash = shared.base58Encode(createHash('sha256').update(signed.subarray(0, signed.length - 65)).digest());
  await rpc('send_tx', { signed_tx_base64: shared.toBase64(signed), wait_until: 'NONE' });
  let tx = null;
  for (let i = 0; i < 60 && !tx; i++) {
    await new Promise((r) => setTimeout(r, 700));
    try { const t = await rpc('tx', { tx_hash: hash, sender_account_id: h.account, wait_until: 'NONE' }); if (t?.status?.SuccessValue !== undefined || t?.status?.Failure) tx = t; } catch { /* not yet */ }
  }
  console.log(`${h.account}: ${tx?.status?.Failure ? 'FAILED ' + JSON.stringify(tx.status.Failure).slice(0, 200) : `added ${todo.length} key(s)`} https://testnet.nearblocks.io/txns/${hash}`);
}

async function rpc(method, params) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message} ${JSON.stringify(body.error.cause ?? '')}`);
  return body.result;
}
