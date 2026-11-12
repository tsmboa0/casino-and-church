import { TGAS } from '@cnc/shared';
import type { Store } from '../db/store.ts';
import type { Hub } from '../indexer/hub.ts';
import { betDetail } from '../indexer/detail.ts';
import type { KeyPool } from '../near/pool.ts';
import type { NearRpc } from '../near/rpc.ts';
import { panicCode, txSucceeded } from '../near/rpc.ts';

export interface RoundBet { bet_id: number; player: string; side: 'up' | 'down'; wager: string; name?: string | null }

export interface MarketSnapshot {
  /** get_market as the chain sees it (optimistic) */
  view: any;
  /** unpaid bets of the open and live rounds, by epoch */
  bets: Record<string, RoundBet[]>;
  /** BTC/USD spot for the chart (an exchange feed; the round result is the OutLayer oracle's price) */
  price: { usd: number; at: number } | null;
  history: [number, number][];
  at: number;
}

export interface KeeperStatus {
  running: boolean;
  ticks: number;
  tickFailures: number;
  settles: number;
  lastError: string | null;
  lastTickAt: number;
}

const HISTORY_MS = 10 * 60_000;

/**
 * Runs the BTC UP/DOWN market:
 *  - reads `get_market` (and the round bet lists) and keeps one snapshot that every player's /market request shares,
 *  - at a round's lock time calls `market_tick` with the OutLayer fee (the keeper account pays it; the unused part is
 *    refunded to it), and `market_settle` while payouts are queued,
 *  - when a round finishes, tells each of its players (SSE `bet_settled`) and records the result in the history,
 *  - keeps a BTC/USD spot feed for the chart while somebody is looking.
 * Idle markets cost nothing: no round is priced unless somebody bet.
 */
export class MarketKeeper {
  snapshot: MarketSnapshot | null = null;
  status: KeeperStatus = { running: false, ticks: 0, tickFailures: 0, settles: 0, lastError: null, lastTickAt: 0 };
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private ticking = false;
  private viewerAt = 0;
  private known = new Map<number, RoundBet[]>();
  private history: [number, number][] = [];
  private priceTimer: NodeJS.Timeout | null = null;
  private priceFails = 0;

  constructor(
    private rpc: NearRpc,
    private pool: KeyPool | null,
    private store: Store,
    private hub: Hub,
    private fetchPrice: () => Promise<number> = spotBtc,
  ) {}

  start() {
    this.status.running = true;
    this.schedule(0);
    this.priceTimer = setInterval(() => { void this.samplePrice(); }, 2_000);
  }

  stop() {
    this.status.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.priceTimer) clearInterval(this.priceTimer);
  }

  /** a market bet was just relayed: look again soon (it lands within a couple of blocks) */
  nudge() {
    this.schedule(1_200);
    setTimeout(() => this.schedule(0), 3_000);
  }

  /** somebody has the market open: keep the snapshot and the chart fresh */
  viewer() {
    const idle = Date.now() - this.viewerAt > 30_000;
    this.viewerAt = Date.now();
    if (idle) { this.schedule(0); void this.samplePrice(); }
  }

  private watching() { return Date.now() - this.viewerAt < 30_000; }

  private schedule(ms: number) {
    if (!this.status.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run(); }, ms);
  }

  private async run() {
    if (this.busy) { this.schedule(300); return; }
    this.busy = true;
    let next = 6_000;
    try {
      next = await this.refresh();
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.error(JSON.stringify({ at: 'market', error: this.status.lastError }));
      next = 3_000;
    } finally {
      this.busy = false;
    }
    this.schedule(next);
  }

  /** one look at the chain; returns how long to wait before the next one */
  private async refresh(): Promise<number> {
    const view = await this.rpc.view('get_market', {}, 'optimistic');
    if (!view) return 15_000;
    const open = view.open, live = view.live;
    const bets: Record<string, RoundBet[]> = {};
    for (const r of [open, live]) {
      if (!r || !r.bets) continue;
      const cached = this.known.get(r.epoch);
      const list = cached && cached.length === r.bets
        ? cached
        : (await this.rpc.view('get_market_bets', { epoch: r.epoch }, 'optimistic') as RoundBet[]) ?? [];
      // keep every bettor we ever saw for this round (paid bets leave the chain list)
      const merged = new Map((cached ?? []).map((b) => [b.bet_id, b]));
      for (const b of list) merged.set(b.bet_id, b);
      this.known.set(r.epoch, [...merged.values()]);
      bets[r.epoch] = await Promise.all(list.map(async (b) => ({ ...b, name: await this.nameOf(b.player) })));
    }
    this.snapshot = { view, bets, price: this.lastPrice(), history: this.history.slice(-300), at: Date.now() };

    // rounds that are neither open nor live any more are finished: tell their players
    for (const [epoch, list] of [...this.known]) {
      const stillOpen = epoch === open?.epoch || epoch === live?.epoch;
      if (stillOpen) continue;
      this.known.delete(epoch);
      void this.announce(epoch, list);
    }

    if (!view.enabled) return 15_000;
    if (this.pool && view.due && !this.ticking) {
      void this.tick(view);
      return 1_500;
    }
    if (this.pool && view.queue > 0 && !view.pending && !this.ticking) void this.settle();
    if (view.pending || this.ticking) return 1_000;
    const nowMs = Number(BigInt(view.now_ns) / 1_000_000n);
    const staked = (open?.bets ?? 0) > 0 || (live?.bets ?? 0) > 0;
    if (staked && open) {
      // wake right at the lock (chain time), then every half second until the chain agrees it is due
      const untilLock = Number(BigInt(open.lock_ns) / 1_000_000n) - nowMs;
      return Math.max(400, Math.min(untilLock + 250, this.watching() ? 2_000 : 10_000));
    }
    return this.watching() ? 2_000 : 6_000;
  }

  private async tick(view: any) {
    this.ticking = true;
    const t0 = Date.now();
    try {
      const sent = await this.pool!.callAndWait('market_tick', {}, 300n * TGAS, BigInt(view.fee));
      this.status.lastTickAt = Date.now();
      if (txSucceeded(sent.tx)) {
        this.status.ticks++;
        const logs: string[] = (sent.tx?.receipts_outcome ?? []).flatMap((r: any) => r.outcome?.logs ?? []);
        const failed = logs.find((l) => l.includes('market_price_failed'));
        if (failed) { this.status.tickFailures++; this.status.lastError = failed.slice(0, 200); }
        console.log(JSON.stringify({ at: 'market', tick: view.open?.epoch, ms: Date.now() - t0, ok: !failed }));
      } else {
        this.status.tickFailures++;
        this.status.lastError = panicCode(sent.tx) ?? 'tick failed';
        console.error(JSON.stringify({ at: 'market', tick: view.open?.epoch, error: this.status.lastError }));
      }
    } catch (err) {
      // a slow oracle can outlast the poll; the next look at the chain shows where it got to
      this.status.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.error(JSON.stringify({ at: 'market', tick: view.open?.epoch, error: this.status.lastError }));
    } finally {
      this.ticking = false;
      this.hub.broadcast('market', { epoch: view.open?.epoch });
      this.schedule(0);
    }
  }

  private async settle() {
    this.ticking = true;
    try {
      const sent = await this.pool!.callAndWait('market_settle', { limit: 40 }, 300n * TGAS);
      if (txSucceeded(sent.tx)) this.status.settles++;
    } catch (err) {
      console.error(JSON.stringify({ at: 'market', settle: true, error: err instanceof Error ? err.message.slice(0, 160) : String(err) }));
    } finally {
      this.ticking = false;
    }
  }

  /** a finished round: each player hears about it and the result goes in the history */
  private async announce(epoch: number, list: RoundBet[]) {
    for (const b of list) {
      try {
        let result: any = null;
        for (let i = 0; i < 12 && !result; i++) {
          result = await this.rpc.view('get_bet_result', { account_id: b.player, bet_id: b.bet_id }, 'optimistic').catch(() => null);
          if (!result) await new Promise((r) => setTimeout(r, 2_500));   // still in the payout queue
        }
        if (!result) continue;
        this.hub.publish(b.player, 'bet_settled', { bet_id: b.bet_id, via: 'oracle', game: 'Market', epoch });
        await this.store.recordBet({
          betId: b.bet_id, accountId: b.player, game: 'Market', wager: String(result.wager), payout: String(result.payout),
          outcome: result.outcome, serverSeed: '', clientSeed: '', chainSeed: '', via: 'oracle', createdAt: Date.now(),
          detail: betDetail('Market', result.outcome), settleMs: null, txHash: null,
          blessing: result.blessing != null ? String(result.blessing) : null,
        });
        const player = await this.rpc.view('get_player', { account_id: b.player }, 'optimistic').catch(() => null);
        if (player) {
          const prev = await this.store.player(b.player);
          const net = (prev ? BigInt(prev.net) : 0n) + BigInt(result.payout) - BigInt(result.wager);
          await this.store.upsertPlayer({
            accountId: b.player, wagered: String(player.stats?.wagered ?? 0), net: net.toString(),
            faithMilli: Number(player.faith_milli ?? 0), name: String(player.name ?? ''),
          });
        }
      } catch (err) {
        console.error(JSON.stringify({ at: 'market', announce: b.bet_id, error: err instanceof Error ? err.message.slice(0, 160) : String(err) }));
      }
    }
  }

  /** the player's username for the crowd list (cached: names rarely change) */
  private names = new Map<string, string | null>();
  private async nameOf(account: string): Promise<string | null> {
    if (this.names.has(account)) return this.names.get(account)!;
    const name = await this.store.nameOf(account).catch(() => null);
    if (this.names.size > 5_000) this.names.clear();
    if (name) this.names.set(account, name);   // a player without a name yet is asked again next time
    return name;
  }

  private lastPrice() {
    const last = this.history[this.history.length - 1];
    return last ? { usd: last[1], at: last[0] } : null;
  }

  private async samplePrice() {
    if (!this.watching() && this.history.length) return;
    // after repeated failures, back off to one try in five
    if (this.priceFails > 3 && Math.random() > 0.2) return;
    try {
      const usd = await this.fetchPrice();
      if (!(usd > 0)) throw new Error('bad price');
      const now = Date.now();
      this.history.push([now, usd]);
      while (this.history.length && this.history[0]![0] < now - HISTORY_MS) this.history.shift();
      this.priceFails = 0;
      if (this.snapshot) { this.snapshot.price = this.lastPrice(); this.snapshot.history = this.history.slice(-300); }
    } catch {
      this.priceFails++;
    }
  }
}

/** BTC/USD spot for the chart: Coinbase, then Kraken, then Bitstamp */
export async function spotBtc(): Promise<number> {
  const sources: [string, (j: any) => number][] = [
    ['https://api.coinbase.com/v2/prices/BTC-USD/spot', (j) => Number(j?.data?.amount)],
    ['https://api.kraken.com/0/public/Ticker?pair=XBTUSD', (j) => Number(Object.values<any>(j?.result ?? {})[0]?.c?.[0])],
    ['https://www.bitstamp.net/api/v2/ticker/btcusd/', (j) => Number(j?.last)],
  ];
  for (const [url, read] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_500), headers: { 'user-agent': 'casino-and-church/1.0' } });
      if (!res.ok) continue;
      const usd = read(await res.json());
      if (usd > 0) return usd;
    } catch { /* next source */ }
  }
  throw new Error('no BTC price source answered');
}
