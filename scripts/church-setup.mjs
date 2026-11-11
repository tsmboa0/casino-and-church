#!/usr/bin/env node
/**
 * One-time Church setup after the v3 upgrade (campaigns):
 *   1. set_roles(oracle_pk = public key of ORACLE_SECRET)            (admin)
 *   2. seed the Church's own campaigns, funded from the treasury       (admin)
 *   3. optional: --gate <account> grants the Founders' Row gate         (admin, for testing a plot)
 *
 *   apps/server/node_modules/.bin/tsx scripts/church-setup.mjs            # dry run
 *   apps/server/node_modules/.bin/tsx scripts/church-setup.mjs --send
 * Reads REALM_CONTRACT, ADMIN_ACCOUNT, ADMIN_SECRET, ORACLE_SECRET, NEAR_RPC_URL from .env.local. Prints no secret.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const shared = await import('../packages/shared/src/index.ts');
const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const send = process.argv.includes('--send');
const gateIx = process.argv.indexOf('--gate');
const gateFor = gateIx > 0 ? process.argv[gateIx + 1] : null;
const rpcUrls = (get('NEAR_RPC_URL') || 'https://near-testnet.drpc.org').split(',').map((s) => s.trim());
const contract = get('REALM_CONTRACT'), admin = get('ADMIN_ACCOUNT');
if (!contract || !admin || !get('ADMIN_SECRET') || !get('ORACLE_SECRET')) { console.error('Need REALM_CONTRACT, ADMIN_ACCOUNT, ADMIN_SECRET, ORACLE_SECRET'); process.exit(1); }
const oraclePk = shared.bytesToHex(shared.keypairFromSecret(shared.hexToBytes(get('ORACLE_SECRET'))).publicKey);

const SEEDS = [
  { kind: 0, title: 'Follow @NEARProtocol on X', url: 'https://x.com/NEARProtocol', machine_id: 0, goal: 0, reward_chips: 2, reward_faith_milli: 3000, max_claims: 50 },
  { kind: 1, title: 'Read how NEAR AI keeps the hosts honest', url: 'https://docs.near.ai/', machine_id: 0, goal: 0, reward_chips: 0, reward_faith_milli: 2000, max_claims: 200 },
  { kind: 0, title: 'Share the game with #NEARHackathon', url: 'https://x.com/intent/post?text=Playing%20The%20Casino%20%26%20The%20Church%20on%20NEAR%20%23NEARHackathon%20%40NEARProtocol', machine_id: 0, goal: 0, reward_chips: 2, reward_faith_milli: 3000, max_claims: 30 },
];
for (const s of SEEDS) { const p = shared.campaignProblem(s); if (p) { console.error(`seed "${s.title}" fails the Church rules: ${p}`); process.exit(1); } }

const roles = await view('get_roles').catch(() => null);
const existing = await view('get_campaigns', { account_id: null }).catch((e) => { console.log('get_campaigns not available yet (upgrade first?):', e.message.slice(0, 80)); return null; });
console.log(`contract  ${contract}\nadmin     ${admin}\noracle pk ${oraclePk.slice(0, 16)}...${roles?.oracle_pk ? ` (on chain: ${String(roles.oracle_pk).slice(0, 16)}...)` : ''}`);
const calls = [{ method: 'set_roles', args: { admin: null, dealer: null, agent: null, oracle_pk: oraclePk }, gas: 30n }];
const titles = new Set((existing ?? []).map((c) => c.title));
for (const s of SEEDS) if (!titles.has(s.title)) calls.push({ method: 'seed_campaign', args: { campaign: s }, gas: 30n });
if (gateFor) calls.push({ method: 'grant_plot_gate', args: { player: gateFor }, gas: 30n });
for (const c of calls) console.log(`  ${c.method}${c.method === 'seed_campaign' ? `  "${c.args.campaign.title}" (${c.args.campaign.reward_chips * c.args.campaign.max_claims} chips from the treasury)` : c.method === 'grant_plot_gate' ? `  ${gateFor}` : ''}`);
if (!send) { console.log('\ndry run. Re-run with --send.'); process.exit(0); }

const secret = shared.parseSecret(get('ADMIN_SECRET'));
const { publicKey } = shared.keypairFromSecret(secret);
// read the key's nonce once (optimistic) and count up locally: a 'final' read lags, so back-to-back calls reused a nonce
const access = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: admin, public_key: shared.publicKeyString(publicKey) });
let nonce = BigInt(access.nonce);
for (const c of calls) {
  nonce += 1n;
  const block = await rpc('block', { finality: 'final' });
  const w = new shared.Writer();
  w.u32(1); w.u8(shared.ACTION_FUNCTION_CALL); w.str(c.method); w.bytes(new TextEncoder().encode(JSON.stringify(c.args))); w.u64(c.gas * 10n ** 12n); w.u128(0n);
  const signed = shared.signTransaction(secret, { signerId: admin, publicKey, nonce, receiverId: contract, blockHash: shared.base58Decode(block.header.hash), actions: w.finish() });
  const hash = shared.base58Encode(createHash('sha256').update(signed.subarray(0, signed.length - 65)).digest());
  await rpc('send_tx', { signed_tx_base64: shared.toBase64(signed), wait_until: 'NONE' });
  let tx = null;
  for (let i = 0; i < 30 && !tx; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const t = await rpc('tx', { tx_hash: hash, sender_account_id: admin, wait_until: 'EXECUTED_OPTIMISTIC' }); if (t?.status) tx = t; } catch { /* not yet */ }
  }
  const failed = tx?.status?.Failure || (tx?.receipts_outcome ?? []).some((r) => r.outcome?.status?.Failure);
  console.log(`${c.method}: ${!tx ? 'NOT SEEN' : failed ? 'FAILED ' + JSON.stringify(tx.status.Failure ?? '').slice(0, 160) : 'ok'}  https://testnet.nearblocks.io/txns/${hash}`);
}
console.log('campaigns now:', (await view('get_campaigns', { account_id: null })).map((c) => `#${c.id} ${c.title}`).join(' | '));

async function view(method, args = {}) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
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
