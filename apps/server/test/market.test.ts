import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/db/memory.ts';
import { Hub } from '../src/indexer/hub.ts';
import { MarketKeeper } from '../src/market/keeper.ts';

const S = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a tiny stand-in for the contract: one open round with alice's bet, then the price closes it */
function fakeChain() {
  const t0 = BigInt(Date.now()) * 1_000_000n;
  const chain = {
    now: t0,
    epoch: 1,
    open: { epoch: 1, phase: 'open', lock_ns: (t0 + 1n * S).toString(), bets: 1 } as any,
    live: null as any,
    recent: [] as any[],
    queue: 0,
    pending: false,
    roundBets: { 1: [{ bet_id: 7, player: 'alice.testnet', side: 'up', wager: '10000000000000000000000' }] } as Record<number, any[]>,
    results: new Map<string, any>(),
    calls: [] as { method: string; deposit: bigint }[],
  };
  const view = () => {
    chain.now = BigInt(Date.now()) * 1_000_000n;
    const due = !chain.pending && (chain.open.bets > 0 || (chain.live?.bets ?? 0) > 0) && chain.now >= BigInt(chain.open.lock_ns);
    return { enabled: true, now_ns: chain.now.toString(), epoch: chain.epoch, pending: chain.pending, open: chain.open, live: chain.live, recent: chain.recent, queue: chain.queue, due, fee: '20000000000000000000000' };
  };
  const rpc = {
    async view(method: string, args: any) {
      if (method === 'get_market') return view();
      if (method === 'get_market_bets') return chain.roundBets[args.epoch] ?? [];
      if (method === 'get_bet_result') return chain.results.get(`${args.account_id}:${args.bet_id}`) ?? null;
      if (method === 'get_player') return { stats: { wagered: '10000000000000000000000' }, faith_milli: 0, name: 'Alice' };
      return null;
    },
  };
  const pool = {
    async callAndWait(method: string, _args: unknown, _gas: bigint, deposit = 0n) {
      chain.calls.push({ method, deposit });
      if (method === 'market_tick') {
        // the price comes back: round 1 goes live, round 2 opens (empty)
        chain.live = { ...chain.open, phase: 'live', lock_price: 7_000_000 };
        chain.epoch = 2;
        chain.open = { epoch: 2, phase: 'open', lock_ns: (chain.now + 60n * S).toString(), bets: 0 };
      }
      if (method === 'market_settle') chain.queue = 0;
      return { hash: 'h', tx: { status: { SuccessValue: '' }, receipts_outcome: [] } };
    },
  };
  return { chain, rpc, pool };
}

test('the keeper prices a round at its lock, then announces and records it when it finishes', async () => {
  const { chain, rpc, pool } = fakeChain();
  const store = new MemoryStore();
  const hub = new Hub();
  const heard: any[] = [];
  hub.add('alice.testnet', (event, data) => { if (event === 'bet_settled') heard.push({ event, data }); });
  const keeper = new MarketKeeper(rpc as any, pool as any, store, hub, async () => 73_500.5);
  keeper.viewer();
  keeper.start();
  try {
    // it waits for the lock (1 s), then ticks once with the fee attached
    await sleep(600);
    assert.equal(chain.calls.length, 0, 'not before the lock');
    for (let i = 0; i < 40 && !chain.calls.length; i++) await sleep(100);
    assert.equal(chain.calls[0]?.method, 'market_tick');
    assert.equal(chain.calls[0]?.deposit, 20_000_000_000_000_000_000_000n, 'the keeper attaches the OutLayer fee');
    // the shared snapshot has the round, its bets and the chart price
    for (let i = 0; i < 30 && keeper.snapshot?.view.epoch !== 2; i++) await sleep(100);
    assert.equal(keeper.snapshot?.view.live.epoch, 1);
    assert.equal(keeper.snapshot?.bets['1']?.[0]?.player, 'alice.testnet');
    assert.equal(keeper.snapshot?.price?.usd, 73_500.5);

    // round 1 closes UP; alice's payout sits in the queue until market_settle
    chain.results.set('alice.testnet:7', {
      game: 'Market', wager: '10000000000000000000000', payout: '19000000000000000000000', blessing: '0',
      outcome: { reels: ['70000.00', '70012.34'], side: 'up', color: 'up' }, via: 'oracle',
    });
    chain.live = null;
    chain.recent = [{ epoch: 1, outcome: 'up' }];
    chain.queue = 1;
    keeper.nudge();
    for (let i = 0; i < 60 && !heard.length; i++) await sleep(100);
    assert.equal(heard[0]?.event, 'bet_settled');
    assert.equal(heard[0]?.data.bet_id, 7);
    const row = await store.bet(7);
    assert.equal(row?.game, 'Market');
    assert.equal(row?.detail, 'BTC UP · $70000.00 → $70012.34');
    assert.ok(chain.calls.some((c) => c.method === 'market_settle'), 'queued payouts are settled');
    const ticks = chain.calls.filter((c) => c.method === 'market_tick').length;
    // nothing at stake now: no more price requests
    await sleep(1_500);
    assert.equal(chain.calls.filter((c) => c.method === 'market_tick').length, ticks, 'an idle market is never priced');
  } finally {
    keeper.stop();
  }
});
