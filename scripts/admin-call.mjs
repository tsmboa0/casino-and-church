#!/usr/bin/env node
/**
 * Send admin function calls to the realm contract, one transaction each, in order.
 *   apps/server/node_modules/.bin/tsx scripts/admin-call.mjs calls.json
 * calls.json: [{ "method": "set_params", "args": { ... }, "gas": 30 }, ...]   (gas in TGas)
 * Reads REALM_CONTRACT, ADMIN_ACCOUNT, ADMIN_SECRET, NEAR_RPC_URL from .env.local. Prints no secret.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const shared = await import('../packages/shared/src/index.ts');
const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const rpcUrls = (get('NEAR_RPC_URL') || 'https://near-testnet.drpc.org').split(',').map((s) => s.trim());
const contract = get('REALM_CONTRACT'), admin = get('ADMIN_ACCOUNT');
const calls = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const secret = shared.parseSecret(get('ADMIN_SECRET'));
const { publicKey } = shared.keypairFromSecret(secret);
const access = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: admin, public_key: shared.publicKeyString(publicKey) });
let nonce = BigInt(access.nonce);
for (const c of calls) {
  nonce += 1n;
  const block = await rpc('block', { finality: 'final' });
  const w = new shared.Writer();
  w.u32(1); w.u8(shared.ACTION_FUNCTION_CALL); w.str(c.method); w.bytes(new TextEncoder().encode(JSON.stringify(c.args))); w.u64(BigInt(c.gas ?? 30) * 10n ** 12n); w.u128(0n);
  const signed = shared.signTransaction(secret, { signerId: admin, publicKey, nonce, receiverId: contract, blockHash: shared.base58Decode(block.header.hash), actions: w.finish() });
  const hash = shared.base58Encode(createHash('sha256').update(signed.subarray(0, signed.length - 65)).digest());
  await rpc('send_tx', { signed_tx_base64: shared.toBase64(signed), wait_until: 'NONE' });
  let tx = null;
  for (let i = 0; i < 30 && !tx; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const t = await rpc('tx', { tx_hash: hash, sender_account_id: admin, wait_until: 'EXECUTED_OPTIMISTIC' }); if (t?.status) tx = t; } catch { /* not yet */ }
  }
  const fail = tx?.status?.Failure ?? (tx?.receipts_outcome ?? []).map((r) => r.outcome?.status?.Failure).find(Boolean);
  const value = tx?.status?.SuccessValue ? Buffer.from(tx.status.SuccessValue, 'base64').toString() : '';
  console.log(`${c.method}: ${!tx ? 'NOT SEEN' : fail ? 'FAILED ' + JSON.stringify(fail).slice(0, 200) : 'ok'}${value ? ` -> ${value}` : ''}  https://testnet.nearblocks.io/txns/${hash}`);
  if (!tx || fail) process.exit(1);
}
async function rpc(method, params) {
  let last;
  for (const url of rpcUrls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const body = await res.json();
      if (body.error) throw new Error(`${body.error.message} ${JSON.stringify(body.error.cause ?? '')}`);
      return body.result;
    } catch (e) { last = e; }
  }
  throw last;
}
