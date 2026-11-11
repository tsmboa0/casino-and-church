#!/usr/bin/env node
/**
 * Twenty guests, mixed bets, five minutes.
 * Exits 0 unless LOAD=1, REALM_CONTRACT, E2E_API and RELAYER_ACCOUNT are all set,
 * so CI does not spend five minutes here.
 *
 * A clean run from one machine needs the server started with
 * ACCOUNTS_PER_IP_DAY=30 (the default is 3) and RELAY_ACCOUNT_HOUR at or above 120.
 * Leave the production defaults in place once the run is over.
 *
 *   LOAD=1 REALM_CONTRACT=realm.you.testnet E2E_API=http://127.0.0.1:8787 \
 *   RELAYER_ACCOUNT=relayer.you.testnet pnpm exec tsx scripts/load.mjs
 */
if (process.env.LOAD !== '1' || !process.env.REALM_CONTRACT || !process.env.E2E_API || !process.env.RELAYER_ACCOUNT) {
  console.log('load skipped: set LOAD=1, REALM_CONTRACT, E2E_API and RELAYER_ACCOUNT');
  process.exit(0);
}

const contract = process.env.REALM_CONTRACT;
const api = process.env.E2E_API.replace(/\/$/, '');
const relayer = process.env.RELAYER_ACCOUNT;
const rpcUrl = (process.env.NEAR_RPC_URL || 'https://near-testnet.drpc.org').split(',')[0].trim();
const guests = Number(process.env.LOAD_GUESTS || 20);
const durationMs = Number(process.env.LOAD_MS || 5 * 60 * 1000);
const CHIP = 10n ** 22n;
const games = [
  ['coin', 0], ['coin', 1], ['slots', 0], ['dice', 0], ['dice', 1], ['dice', 3],
  ['roulette', 17], ['roulette', 100], ['roulette', 110],
];

const shared = await import('../packages/shared/src/index.ts');
const settleMs = [];
const counts = { nonce: 0, quota: 0, timeout: 0, other: 0, placed: 0 };

async function rpc(method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

async function view(method, args) {
  const result = await rpc('query', {
    request_type: 'call_function', account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'optimistic',
  });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function guest() {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const { publicKey } = shared.keypairFromSecret(secret);
  const accountId = shared.bytesToHex(publicKey);
  const created = await fetch(`${api}/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: accountId }),
  });
  if (!created.ok) throw new Error(await created.text());
  for (let i = 0; i < 30; i++) {
    try {
      await rpc('query', {
        request_type: 'view_access_key', finality: 'optimistic', account_id: accountId,
        public_key: `ed25519:${shared.base58Encode(publicKey)}`,
      });
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  const faucet = await fetch(`${api}/faucet`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId }),
  });
  if (!faucet.ok) throw new Error(await faucet.text());
  const tip = await rpc('block', { finality: 'final' });
  const key = await rpc('query', {
    request_type: 'view_access_key', finality: 'optimistic', account_id: accountId,
    public_key: `ed25519:${shared.base58Encode(publicKey)}`,
  });
  const signed = shared.signDelegate(secret, {
    senderId: accountId, receiverId: contract, publicKey, nonce: BigInt(key.nonce) + 1n,
    maxBlockHeight: BigInt(tip.header.height) + 80n,
    actions: [{ methodName: 'claim_welcome', args: new TextEncoder().encode('{}'), gas: 40n * shared.TGAS, deposit: 0n }],
  });
  const welcomed = await fetch(`${api}/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed_delegate: shared.toBase64(shared.encodeSignedDelegate(signed)) }),
  });
  if (!welcomed.ok) throw new Error(await welcomed.text());
  return { secret, publicKey, accountId };
}

async function place(player, game, pick) {
  const key = await rpc('query', {
    request_type: 'view_access_key', finality: 'optimistic', account_id: player.accountId,
    public_key: `ed25519:${shared.base58Encode(player.publicKey)}`,
  });
  const tip = await rpc('block', { finality: 'final' });
  const signed = shared.signDelegate(player.secret, {
    senderId: player.accountId, receiverId: contract, publicKey: player.publicKey,
    nonce: BigInt(key.nonce) + 1n, maxBlockHeight: BigInt(tip.header.height) + 80n,
    actions: [{
      methodName: 'place_bet',
      args: new TextEncoder().encode(JSON.stringify({
        game, wager: (10n * CHIP).toString(), pick, machine_id: 0,
        client_seed: shared.bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      })),
      gas: 80n * shared.TGAS, deposit: 0n,
    }],
  });
  const started = Date.now();
  const res = await fetch(`${api}/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed_delegate: shared.toBase64(shared.encodeSignedDelegate(signed)) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(body.error || '');
    if (code === 'quota' || code === 'rate_limited' || res.status === 429) counts.quota++;
    else if (/nonce/i.test(body.message || '')) counts.nonce++;
    else counts.other++;
    return;
  }
  counts.placed++;
  for (let i = 0; i < 40; i++) {
    const tx = await rpc('tx', { tx_hash: body.tx_hash, sender_account_id: relayer, wait_until: 'NONE' }).catch(() => null);
    const line = JSON.stringify(tx?.receipts_outcome ?? []);
    const betId = Number(line.match(/"bet_id":"(\d+)"/)?.[1] || 0);
    if (!betId) { await new Promise((r) => setTimeout(r, 400)); continue; }
    const row = await view('get_bet_result', { account_id: player.accountId, bet_id: betId }).catch(() => null);
    if (row) {
      settleMs.push(Date.now() - started);
      if (row.via === 'timeout') counts.timeout++;
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  counts.timeout++;
}

const vaultBefore = BigInt((await view('get_pools', {})).vault);
const players = [];
for (let i = 0; i < guests; i++) {
  try { players.push(await guest()); }
  catch (err) { counts.other++; console.error(err instanceof Error ? err.message : err); }
}
if (!players.length) {
  console.error('no guests were created; raise ACCOUNTS_PER_IP_DAY');
  process.exit(1);
}

const until = Date.now() + durationMs;
let turn = 0;
const loops = players.map(async (player) => {
  while (Date.now() < until) {
    const [game, pick] = games[turn++ % games.length];
    await place(player, game, pick);
    await new Promise((r) => setTimeout(r, 1500));
  }
});
await Promise.all(loops);

const vaultAfter = BigInt((await view('get_pools', {})).vault);
const sorted = [...settleMs].sort((a, b) => a - b);
const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : 0;
const report = {
  guests: players.length,
  placed: counts.placed,
  settled: settleMs.length,
  p50: at(50),
  p95: at(95),
  max: sorted.at(-1) ?? 0,
  nonce_errors: counts.nonce,
  quota_rejections: counts.quota,
  timeouts: counts.timeout,
  other_errors: counts.other,
  vault_drift_yocto: (vaultAfter - vaultBefore).toString(),
};
console.log(JSON.stringify(report, null, 2));
process.exit(counts.other > counts.placed ? 1 : 0);
