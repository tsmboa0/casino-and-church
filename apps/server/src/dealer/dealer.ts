import { randomBytes, createHash } from 'node:crypto';
import { TGAS } from '@cnc/shared';
import type { Store } from '../db/store.ts';
import { decryptSeed, encryptSeed } from './crypto.ts';
import type { KeyPool } from '../near/pool.ts';
import type { NearRpc } from '../near/rpc.ts';
import { panicCode, txSucceeded } from '../near/rpc.ts';
import type { Hub } from '../indexer/hub.ts';
import { betDetail } from '../indexer/detail.ts';

export interface DealerStatus {
  running: boolean;
  commitsAvailable: number;
  pendingBets: number;
  oldestPendingAgeS: number;
  cursor: number;
  inflight: number;
}

interface OpenBet {
  bet_id: number;
  player: string;
  commit_idx: number;
  placed_height: number;
  game: string;
  wager: string;
}

/**
 * Keeps the commit pool full and reveals pending bets. It watches the chain at OPTIMISTIC finality: a bet is seen
 * 2-3 blocks sooner, and a reveal for a bet that is not (yet) there simply fails and is retried.
 * Seeds are AES-256-GCM at rest. Plaintext exists only for the reveal call.
 * Reveals for different bets run together, one in flight per bet. A refill
 * never waits in front of a reveal.
 */
export class Dealer {
  status: DealerStatus = { running: false, commitsAvailable: 0, pendingBets: 0, oldestPendingAgeS: 0, cursor: 1, inflight: 0 };
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private refilling = false;
  private inflight = new Map<number, number>();
  private seenAt = new Map<number, number>();
  private oldestHeight = 0;
  private concurrency: number;

  constructor(
    private rpc: NearRpc,
    private pool: KeyPool,
    private store: Store,
    private hub: Hub,
    private encKey: Buffer,
  ) {
    const asked = Number(process.env.DEALER_CONCURRENCY || pool.size || 4);
    this.concurrency = Math.max(1, asked);
  }

  start() {
    this.status.running = true;
    this.timer = setInterval(() => { void this.tick(); }, 400);
    void this.tick();
  }

  stop() {
    this.status.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.scanning || !this.status.running) return;
    this.scanning = true;
    try {
      const pools = await this.rpc.view('get_pools', {}, 'optimistic');
      this.status.commitsAvailable = Number(pools.commits_available ?? 0);
      this.status.pendingBets = Number(pools.pending_bets ?? 0);
      if (this.status.commitsAvailable < 60 && !this.refilling) {
        this.refilling = true;
        void this.refill(BigInt(pools.commit_tail ?? 0)).finally(() => { this.refilling = false; });
      }
      await this.kick(BigInt(pools.next_bet_id ?? 1));
      const tip = await this.rpc.tip();
      this.status.oldestPendingAgeS = this.oldestHeight ? Math.max(0, Number(tip.height) - this.oldestHeight) : 0;
      this.status.inflight = this.inflight.size;
    } catch (err) {
      console.error(JSON.stringify({ at: 'dealer', error: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.scanning = false;
    }
  }

  private async refill(tail: bigint) {
    const pending = await this.store.seedsByStatus('pending_commit');
    for (const row of pending) {
      if (BigInt(row.idx) < tail) await this.store.markSeed(row.idx, 'committed');
    }
    const rest = pending.filter((row) => BigInt(row.idx) >= tail);
    let commits: string[];
    let from = tail;
    if (rest.length && BigInt(rest[0]!.idx) === tail) {
      commits = rest.slice(0, 100).map((row) => row.commit);
      from = BigInt(rest[0]!.idx);
    } else {
      const seeds = Array.from({ length: 100 }, () => randomBytes(32));
      commits = seeds.map((seed) => createHash('sha256').update(seed).digest('hex'));
      from = tail;
      for (let i = 0; i < seeds.length; i++) {
        await this.store.putSeed({
          idx: Number(from + BigInt(i)),
          commit: commits[i]!,
          seedEnc: encryptSeed(this.encKey, seeds[i]!),
          status: 'pending_commit',
        });
      }
    }
    const sent = await this.pool.callAndWait('commit_batch', { commits }, 80n * TGAS);
    if (!txSucceeded(sent.tx)) throw new Error(panicCode(sent.tx) ?? 'commit failed');
    for (let i = 0; i < commits.length; i++) await this.store.markSeed(Number(from + BigInt(i)), 'committed');
  }

  /** Start reveals up to the lane count. The cursor moves only past settled ids. */
  private async kick(nextBetId: bigint) {
    const from = this.status.cursor;
    if (BigInt(from) >= nextBetId && this.inflight.size === 0) {
      this.oldestHeight = 0;
      return;
    }
    const page = await this.rpc.view('get_bets', { from_id: from, limit: 50 }, 'optimistic') as (null | OpenBet)[];
    let cursor = from;
    let blocked = false;
    let oldest = 0;
    const consider = (height: number) => { if (!oldest || height < oldest) oldest = height; };
    for (const height of this.inflight.values()) consider(height);
    for (let i = 0; i < page.length; i++) {
      const betId = from + i;
      if (BigInt(betId) >= nextBetId) break;
      const bet = page[i];
      if (!bet) {
        if (!blocked) cursor = betId + 1;
        continue;
      }
      consider(Number(bet.placed_height));
      if (!this.seenAt.has(bet.bet_id)) this.seenAt.set(bet.bet_id, Date.now());
      if (this.inflight.has(bet.bet_id) || this.inflight.size >= this.concurrency) {
        blocked = true;
        continue;
      }
      if (bet.game === 'Blackjack') {
        const hand = await this.rpc.view('get_blackjack', { bet_id: bet.bet_id }, 'optimistic') as { stage?: string } | null;
        if (hand?.stage === 'player') {
          blocked = true;
          continue;
        }
      }
      this.inflight.set(bet.bet_id, Number(bet.placed_height));
      blocked = true;
      void this.drive(bet).finally(() => this.inflight.delete(bet.bet_id));
    }
    this.oldestHeight = oldest;
    this.status.cursor = cursor;
    this.status.inflight = this.inflight.size;
  }

  private async drive(bet: OpenBet) {
    try {
      if (bet.game === 'Blackjack') {
        await this.playBlackjack(bet);
        return;
      }
      const row = await this.store.seed(Number(bet.commit_idx));
      if (!row) return;
      const seed = decryptSeed(this.encKey, row.seedEnc);
      const t0 = Date.now();
      const sent = await this.pool.callAndWait('reveal', { bet_id: bet.bet_id, server_seed: seed.toString('hex') }, 80n * TGAS);
      if (process.env.DEALER_TIMING === '1') {
        console.log(JSON.stringify({ at: 'reveal', bet_id: bet.bet_id, seen_ms: t0 - (this.seenAt.get(bet.bet_id) ?? t0), reveal_ms: Date.now() - t0 }));
      }
      const code = panicCode(sent.tx);
      if (!txSucceeded(sent.tx) && code !== 'unknown_bet') return;
      await this.store.markSeed(row.idx, 'revealed');
      await this.record(bet.player, bet.bet_id, seed.toString('hex'), 'reveal', sent.hash);
    } catch (err) {
      console.error(JSON.stringify({ at: 'reveal', bet_id: bet.bet_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** One step of a blackjack hand. Steps of one hand never overlap. */
  private async playBlackjack(bet: OpenBet): Promise<boolean> {
    const hand = await this.rpc.view('get_blackjack', { bet_id: bet.bet_id }, 'optimistic') as null | {
      stage: string; cards_dealt: number; commit_idx: number;
    };
    if (!hand || hand.stage === 'player') return !hand;
    const count = hand.stage === 'undealt' ? 3 : 1;
    const seeds: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await this.store.seed(Number(hand.commit_idx) + hand.cards_dealt + i);
      if (!row) return false;
      seeds.push(decryptSeed(this.encKey, row.seedEnc).toString('hex'));
    }
    const sent = await this.pool.callAndWait('blackjack_show', { bet_id: bet.bet_id, seeds }, 150n * TGAS);
    if (!txSucceeded(sent.tx) && panicCode(sent.tx) !== 'unknown_bet') return false;
    const after = await this.rpc.view('get_blackjack', { bet_id: bet.bet_id }, 'optimistic');
    const markTo = after ? hand.cards_dealt + count : 18;
    for (let i = 0; i < markTo; i++) await this.store.markSeed(Number(hand.commit_idx) + i, 'revealed');
    if (!after) await this.record(bet.player, bet.bet_id, seeds[0] ?? '', 'reveal', sent.hash);
    return !after;
  }

  private async record(accountId: string, betId: number, serverSeed: string, via: string, txHash?: string) {
    try {
      // the reveal was just executed; a 'final' read can lag by 2-3 blocks, so read optimistic and retry briefly
      let result: any = null;
      for (let i = 0; i < 10 && !result; i++) {
        result = await this.rpc.view('get_bet_result', { account_id: accountId, bet_id: betId }, 'optimistic').catch(() => null);
        if (!result) await new Promise((r) => setTimeout(r, 600));
      }
      if (!result) { console.error(JSON.stringify({ at: 'index', bet_id: betId, error: 'result not visible after reveal' })); return; }
      const player = await this.rpc.view('get_player', { account_id: accountId }, 'optimistic');
      const started = this.seenAt.get(betId) ?? Date.now();
      this.seenAt.delete(betId);
      await this.store.recordBet({
        betId, accountId, game: String(result.game), wager: String(result.wager),
        payout: String(result.payout), outcome: result.outcome, serverSeed,
        clientSeed: String(result.client_seed), chainSeed: String(result.chain_seed), via: String(result.via ?? via),
        createdAt: Date.now(), detail: betDetail(String(result.game), result.outcome), settleMs: Date.now() - started, txHash: txHash ?? null,
        blessing: result.blessing != null ? String(result.blessing) : null,
      });
      if (player) {
        const prev = await this.store.player(accountId);
        const net = (prev ? BigInt(prev.net) : 0n) + BigInt(result.payout) - BigInt(result.wager);
        await this.store.upsertPlayer({
          accountId, wagered: String(player.stats?.wagered ?? 0), net: net.toString(),
          faithMilli: Number(player.faith_milli ?? 0), name: String(player.name ?? ''),
        });
      }
      this.hub.publish(accountId, 'bet_settled', { bet_id: betId, via: result.via });
    } catch (err) {
      console.error(JSON.stringify({ at: 'index', error: err instanceof Error ? err.message : String(err) }));
    }
  }
}
