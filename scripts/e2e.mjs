#!/usr/bin/env node
/**
 * A real guest against a running server and the testnet contract.
 * `node scripts/e2e.mjs` exits 0 when REALM_CONTRACT or E2E_API is unset.
 * A live pass is `pnpm exec tsx scripts/e2e.mjs`. It writes
 * packages/sim/e2e-report.json only after it has played. A mismatch exits 1.
 */
const contract = process.env.REALM_CONTRACT || '';
const api = (process.env.E2E_API || '').replace(/\/$/, '');
if (!contract || !api) {
  console.log('e2e skipped: set REALM_CONTRACT and E2E_API, then run with tsx');
  process.exit(0);
}

// first endpoint of NEAR_RPC_URL (a comma list on the server); rpc.testnet.near.org is deprecated and answers 429
const rpcUrl = (process.env.NEAR_RPC_URL || 'https://near-testnet.drpc.org').split(',')[0].trim();
const relayer = process.env.RELAYER_ACCOUNT || '';
const CHIP = 10n ** 22n;
const NEAR = 10n ** 24n;

const shared = await import('../packages/shared/src/index.ts');
const { assertOutcome } = await import('../apps/client/src/chain/verify.ts');
const { writeFileSync } = await import('node:fs');

const secret = crypto.getRandomValues(new Uint8Array(32));
const { publicKey } = shared.keypairFromSecret(secret);
const accountId = shared.bytesToHex(publicKey);
const calls = [];
const failures = [];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function rpc(method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

async function view(method, args) {
  const result = await rpc('query', {
    request_type: 'call_function',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    finality: 'optimistic',
  });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

async function wallet() {
  const row = await rpc('query', { request_type: 'view_account', account_id: accountId, finality: 'optimistic' });
  return BigInt(row.amount);
}

async function chipsOf() {
  const player = await view('get_player', { account_id: accountId });
  return BigInt(player?.chips ?? 0);
}

async function nextNonce() {
  const row = await rpc('query', {
    request_type: 'view_access_key',
    finality: 'optimistic',
    account_id: accountId,
    public_key: `ed25519:${shared.base58Encode(publicKey)}`,
  });
  return BigInt(row.nonce) + 1n;
}

/** poll a tx without asking the provider to hold the request open (free plans answer 408 to long waits) */
async function pollTx(hash, sender) {
  let last = 'not executed';
  for (let i = 0; i < 80; i++) {
    try {
      const tx = await rpc('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' });
      const stage = String(tx?.final_execution_status ?? '');
      if (!['NONE', 'INCLUDED', 'INCLUDED_FINAL'].includes(stage) && tx?.status && typeof tx.status === 'object'
        && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status || 'Failure' in tx.status)) return tx;
    } catch (err) { last = err instanceof Error ? err.message : String(err); }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`transaction was not executed: ${last}`);
}

async function sendSigned(bytes, sender) {
  const { createHash } = await import('node:crypto');
  const hash = shared.base58Encode(createHash('sha256').update(bytes.subarray(0, bytes.length - 65)).digest());
  try {
    await rpc('send_tx', { signed_tx_base64: shared.toBase64(bytes), wait_until: 'NONE' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/method (is )?not (available|found)|unknown variant/i.test(message)) await rpc('broadcast_tx_async', [shared.toBase64(bytes)]);
    else if (!/408|429|5\d\d|timeout/i.test(message)) throw err;
  }
  return pollTx(hash, sender);
}

function logsOf(tx) {
  const logs = [];
  for (const receipt of tx?.receipts_outcome ?? []) logs.push(...(receipt.outcome?.logs ?? []));
  return logs;
}

function eventData(tx, name) {
  for (const line of logsOf(tx)) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    const parsed = JSON.parse(line.slice('EVENT_JSON:'.length));
    if (parsed.event === name) return Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  }
  return null;
}

function txFailed(tx) {
  const status = tx?.status;
  if (status?.Failure || status?.failure) return true;
  return (tx?.receipts_outcome ?? []).some((row) => row.outcome?.status?.Failure);
}

async function timed(name, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    calls.push({ name, ms: Date.now() - start, ok: true });
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    calls.push({ name, ms: Date.now() - start, ok: false, error: message });
    failures.push({ name, message });
    return null;
  }
}

async function relay(method, args, gas) {
  if (!relayer) throw new Error('set RELAYER_ACCOUNT so the script can read the wrapper transaction');
  const tip = await rpc('block', { finality: 'final' });
  const signed = shared.signDelegate(secret, {
    senderId: accountId,
    receiverId: contract,
    actions: [{
      methodName: method,
      args: new TextEncoder().encode(JSON.stringify(args ?? {})),
      gas,
      deposit: 0n,
    }],
    nonce: await nextNonce(),
    maxBlockHeight: BigInt(tip.header.height) + 80n,
    publicKey,
  });
  const res = await fetch(`${api}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed_delegate: shared.toBase64(shared.encodeSignedDelegate(signed)) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `relay ${res.status}`);
  const hash = String(body.tx_hash);
  const tx = await pollTx(hash, relayer);
  if (txFailed(tx)) throw new Error(`${method} failed on chain`);
  return { hash, tx };
}

async function direct(method, args, gas, deposit) {
  const tip = await rpc('block', { finality: 'final' });
  const w = new shared.Writer();
  w.u32(1);
  w.u8(shared.ACTION_FUNCTION_CALL);
  w.str(method);
  w.bytes(new TextEncoder().encode(JSON.stringify(args ?? {})));
  w.u64(gas);
  w.u128(deposit);
  const signed = shared.signTransaction(secret, {
    signerId: accountId,
    publicKey,
    nonce: await nextNonce(),
    receiverId: contract,
    blockHash: shared.base58Decode(tip.header.hash),
    actions: w.finish(),
  });
  const tx = await sendSigned(signed, accountId);
  if (txFailed(tx)) throw new Error(`${method} failed`);
  return tx;
}

async function waitResult(betId) {
  for (let i = 0; i < 40; i++) {
    const row = await view('get_bet_result', { account_id: accountId, bet_id: betId });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`bet ${betId} was not settled`);
}

async function play(name, game, wager, pick) {
  return timed(name, async () => {
    const before = await chipsOf();
    const clientSeed = crypto.getRandomValues(new Uint8Array(32));
    const sent = await relay('place_bet', {
      game, wager: (BigInt(wager) * CHIP).toString(), pick, client_seed: shared.bytesToHex(clientSeed), machine_id: 0,
    }, 80n * shared.TGAS);
    if (txFailed(sent.tx)) throw new Error(`${game} was rejected`);
    const placed = eventData(sent.tx, 'bet_placed');
    const betId = Number(placed?.bet_id || 0);
    if (!betId) throw new Error('the receipt had no bet id');
    const result = await waitResult(betId);
    const proof = assertOutcome(result, sent.hash);
    const after = await chipsOf();
    if (after - before !== BigInt(result.payout) - BigInt(result.wager)) {
      throw new Error(`chip delta ${after - before} is not payout-wager`);
    }
    if (proof.net !== Number(BigInt(result.payout) / CHIP) - Number(BigInt(result.wager) / CHIP)) {
      throw new Error('chip delta does not match the proof');
    }
    return { betId, game: result.game };
  });
}

async function until(label, pred, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not land`);
}

await timed('account', async () => {
  const res = await fetch(`${api}/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_key: accountId }),
  });
  if (!res.ok) throw new Error(await res.text());
  await until('account', async () => {
    try { await nextNonce(); return true; } catch { return false; }
  });
});

await timed('faucet', async () => {
  const res = await fetch(`${api}/faucet`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId }),
  });
  if (!res.ok) throw new Error(await res.text());
  await until('faucet', async () => (await wallet()) > 4n * 10n ** 23n);   // the faucet pays FAUCET_YOCTO (0.5 NEAR by default)
});

await timed('deposit', async () => {
  const balance = await wallet();
  const gasReserve = 3n * 10n ** 23n;
  const five = 5n * NEAR;
  const amount = balance > five + gasReserve ? five : balance > gasReserve * 2n ? balance - gasReserve : 0n;
  if (amount < CHIP) throw new Error('the faucet did not leave enough NEAR to deposit');
  await direct('deposit', {}, 30n * shared.TGAS, amount);
});

await timed('claim_welcome', () => relay('claim_welcome', {}, 40n * shared.TGAS));

for (let i = 0; i < 5; i++) await play(`coin-${i + 1}`, 'coin', 10, i % 2);
for (let i = 0; i < 5; i++) await play(`slots-${i + 1}`, 'slots', 10, 0);
for (const pick of [0, 1, 3]) await play(`dice-${pick}`, 'dice', 10, pick);
for (const pick of [17, 100, 110]) await play(`roulette-${pick}`, 'roulette', 10, pick);

// LUCK to 100 for the Wheel. Bet the table's largest allowed chip; when the table limit makes that a long grind
// (a 10-chip deploy needs ~125 flips), report the step as skipped instead of burning test NEAR.
const table = await view('get_params', {});
const bigChip = Math.max(...table.allowed_wagers.map(Number).filter((w) => w <= Number(table.effective_max_bet_chips ?? table.max_bet_chips)));
const perBet = Math.min(Number(table.luck_per_bet_cap_milli), bigChip * Number(table.luck_per_chip_milli));
const betsForWheel = Math.ceil(100_000 / Math.max(1, perBet));
if (betsForWheel <= 20) {
  await timed('luck-topup', async () => {
    for (let i = 0; i < betsForWheel + 4; i++) {
      const player = await view('get_player', { account_id: accountId });
      if (Number(player.luck_milli) >= 100_000) return player.luck_milli;
      const row = await play(`luck-${i + 1}`, 'coin', bigChip, 0);
      if (!row) throw new Error('a luck top-up bet failed');
    }
    const player = await view('get_player', { account_id: accountId });
    if (Number(player.luck_milli) < 100_000) throw new Error(`luck is ${player.luck_milli}, not 100000`);
    return player.luck_milli;
  });
  await play('wheel', 'wheel', 0, 0);
} else {
  calls.push({ name: 'wheel', ms: 0, ok: true, skipped: `needs ${betsForWheel} bets of ${bigChip} chips to fill LUCK at this table limit` });
  console.log(`wheel: skipped (needs ${betsForWheel} bets of ${bigChip} chips at this table limit)`);
}

await timed('blackjack', async () => {
  const before = await chipsOf();
  const clientSeed = crypto.getRandomValues(new Uint8Array(32));
  const sent = await relay('place_bet', {
    game: 'blackjack', wager: (10n * CHIP).toString(), pick: 0, client_seed: shared.bytesToHex(clientSeed), machine_id: 0,
  }, 80n * shared.TGAS);
  if (txFailed(sent.tx)) throw new Error('blackjack was rejected');
  const betId = Number(eventData(sent.tx, 'bet_placed')?.bet_id || 0);
  if (!betId) throw new Error('the hand had no bet id');
  let hand = null;
  for (let i = 0; i < 30; i++) {
    const settled = await view('get_bet_result', { account_id: accountId, bet_id: betId });
    if (settled) {
      assertOutcome(settled, sent.hash);
      const after = await chipsOf();
      if (after - before !== BigInt(settled.payout) - BigInt(settled.wager)) throw new Error('blackjack chip delta mismatch');
      return { betId, action: 'natural' };
    }
    hand = await view('get_blackjack', { bet_id: betId });
    if (hand?.stage === 'player' || hand?.stage === 'need_card') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (hand?.stage !== 'player' && hand?.stage !== 'need_card') throw new Error('the dealer did not deal');
  const action = hand.player_total >= 17 ? 'stand' : 'hit';
  const acted = await relay('blackjack_act', { bet_id: betId, action }, 50n * shared.TGAS);
  if (txFailed(acted.tx)) throw new Error(`blackjack ${action} was rejected`);
  const result = await waitResult(betId);
  assertOutcome(result, sent.hash);
  const after = await chipsOf();
  if (after - before !== BigInt(result.payout) - BigInt(result.wager)) throw new Error('blackjack chip delta mismatch');
  return { betId, action };
});

await timed('tithe', () => relay('tithe', { chips: 10 }, 40n * shared.TGAS));
await timed('light_candle', () => relay('light_candle', {}, 40n * shared.TGAS));
await timed('offer_luck', () => relay('offer_luck', { luck_milli: 10_000 }, 40n * shared.TGAS));
await timed('claim_quest', () => relay('claim_quest', { quest_id: 'q-flip' }, 40n * shared.TGAS));

await timed('withdraw', async () => {
  const before = await wallet();
  const sent = await relay('withdraw', { amount: (100n * CHIP).toString() }, 40n * shared.TGAS);
  if (txFailed(sent.tx)) throw new Error('withdraw was rejected');
  let after = before;
  for (let i = 0; i < 20; i++) {
    after = await wallet();
    if (after !== before) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const delta = after - before;
  if (delta < NEAR - 10n ** 21n) throw new Error(`wallet rose by ${delta}, expected about 1 NEAR`);
  return { delta: delta.toString() };
});

const ok = calls.filter((row) => row.ok).map((row) => row.ms).sort((a, b) => a - b);
const report = {
  at: new Date().toISOString(),
  account: accountId,
  contract,
  calls,
  failures,
  p50: percentile(ok, 50),
  p95: percentile(ok, 95),
};
writeFileSync(new URL('../packages/sim/e2e-report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ account: accountId, p50: report.p50, p95: report.p95, failures: failures.length }));
process.exit(failures.length ? 1 : 0);
