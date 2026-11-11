#!/usr/bin/env node
/**
 * Upgrade the live `realm` contract IN PLACE, keeping every balance, player and bet:
 *   one transaction = DeployContract(new wasm) + FunctionCall migrate({ priest })
 * so the chain never runs new code on old state (if migrate fails, the deploy reverts with it).
 *
 *   pnpm exec tsx scripts/upgrade.mjs            # dry run: prints what it would do
 *   pnpm exec tsx scripts/upgrade.mjs --send     # deploys
 *
 * Reads REALM_CONTRACT, REALM_SECRET (the contract account's full-access key), PRIEST_ACCOUNT and NEAR_RPC_URL from
 * .env / .env.local. Prints no secret. Build first: (cd contracts/realm && cargo build --target wasm32-unknown-unknown --release)
 * The v1 -> v2 migration was replayed against a dump of the live state (contracts/realm/src/tests.rs,
 * `live_state_migrates_and_every_record_still_decodes`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const shared = await import('../packages/shared/src/index.ts');
const env = { ...loadEnv(), ...process.env };
const send = process.argv.includes('--send');
const contract = env.REALM_CONTRACT;
const priest = env.PRIEST_ACCOUNT || null;
const rpcUrl = (env.NEAR_RPC_URL || 'https://near-testnet.drpc.org').split(',')[0].trim();
const wasmPath = new URL('../contracts/realm/target/wasm32-unknown-unknown/release/realm.wasm', import.meta.url);
if (!contract || !env.REALM_SECRET) fail('REALM_CONTRACT and REALM_SECRET are required.');
if (!existsSync(wasmPath)) fail('Build the wasm first.');
const code = readFileSync(wasmPath);
if (code.length >= 655_360) fail(`wasm is ${code.length} bytes, over the 640 KB budget`);

const secret = shared.parseSecret(env.REALM_SECRET);
const { publicKey } = shared.keypairFromSecret(secret);
const pk = shared.publicKeyString(publicKey);

const before = await view('get_pools');
const head = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: contract });
console.log(`contract   ${contract}`);
console.log(`rpc        ${new URL(rpcUrl).host}`);
console.log(`on chain   code ${head.code_hash}, storage ${head.storage_usage} bytes`);
console.log(`new wasm   ${code.length} bytes, sha256 ${createHash('sha256').update(code).digest('hex').slice(0, 16)}…`);
console.log(`migrate    priest = ${priest ?? '(the agent, until set_priest)'}`);
console.log(`pools      vault ${chips(before.vault)} · treasury ${chips(before.treasury)} · jackpot ${chips(before.jackpot)} chips · pending bets ${before.pending_bets}`);
if (Number(before.pending_bets) > 0) console.log('note: bets are pending; they survive the upgrade and the dealer reveals them after.');
if (!send) { console.log('\ndry run. Re-run with --send to deploy.'); process.exit(0); }

const w = new shared.Writer();
w.u32(2);
w.u8(1);                                                        // DeployContract { code }
w.bytes(code);
w.u8(shared.ACTION_FUNCTION_CALL);                              // migrate({ priest })
w.str('migrate');
w.bytes(new TextEncoder().encode(JSON.stringify({ priest })));
w.u64(200n * shared.TGAS);
w.u128(0n);
const access = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: contract, public_key: pk });
const block = await rpc('block', { finality: 'final' });
const signed = shared.signTransaction(secret, {
  signerId: contract, publicKey, nonce: BigInt(access.nonce) + 1n, receiverId: contract,
  blockHash: shared.base58Decode(block.header.hash), actions: w.finish(),
});
const hash = shared.base58Encode(createHash('sha256').update(signed.subarray(0, signed.length - 65)).digest());
console.log(`\nsending    ${hash}`);
await rpc('send_tx', { signed_tx_base64: shared.toBase64(signed), wait_until: 'NONE' }).catch((e) => console.log('send:', e.message.slice(0, 160)));
let tx = null;
for (let i = 0; i < 80 && !tx; i++) {
  await new Promise((r) => setTimeout(r, 750));
  try {
    const t = await rpc('tx', { tx_hash: hash, sender_account_id: contract, wait_until: 'NONE' });
    if (t?.status && typeof t.status === 'object' && ('SuccessValue' in t.status || 'Failure' in t.status)) tx = t;
  } catch { /* not seen yet */ }
}
if (!tx) fail(`no result yet; check https://testnet.nearblocks.io/txns/${hash}`);
if ('Failure' in tx.status) fail(`upgrade FAILED and was reverted: ${JSON.stringify(tx.status.Failure).slice(0, 300)}`);
const after = await view('get_pools');
const events = await view('get_events');
const params = await view('get_params');
console.log(`upgraded   ✓ https://testnet.nearblocks.io/txns/${hash}`);
console.log(`pools      vault ${chips(after.vault)} · treasury ${chips(after.treasury)} · jackpot ${chips(after.jackpot)} chips`);
console.log(`get_events ${JSON.stringify(events)} · candle_faith ${params.candle_faith_milli}`);
if (after.vault !== before.vault || after.treasury !== before.treasury) console.log('note: pools moved during the upgrade (live bets settled); that is expected.');

function chips(y) { return (BigInt(y) / 10n ** 22n).toString(); }
async function view(method) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: shared.toBase64(new TextEncoder().encode('{}')) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}
async function rpc(method, params) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message} ${JSON.stringify(body.error.cause ?? body.error.data ?? '')}`);
  return body.result;
}
function loadEnv() {
  const out = {};
  for (const name of ['.env', '.env.local']) {
    const path = new URL(`../${name}`, import.meta.url);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
function fail(m) { console.error(m); process.exit(1); }
