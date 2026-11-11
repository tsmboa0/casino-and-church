import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@cnc/shared';
import {
  HARMONY_PRIZES, WHEEL_PRIZES, drawsOf, pickWeighted, resolveCoin, resolveDice, resolveRoulette, resolveSlots,
} from '../core/rules';
import type { BetResult } from '../core/backend';
import { BackendError } from '../core/errors';
import type { BetResultView } from './types';

function hashReveal(server: Uint8Array, client: Uint8Array, chain: Uint8Array, betId: number): Uint8Array {
  const buf = new Uint8Array(104);
  buf.set(server, 0); buf.set(client, 32); buf.set(chain, 64);
  new DataView(buf.buffer).setBigUint64(96, BigInt(betId), true);
  return sha256(buf);
}

function hashTimeout(client: Uint8Array, chain: Uint8Array, block: Uint8Array, betId: number): Uint8Array {
  const buf = new Uint8Array(111);
  buf.set(client, 0); buf.set(chain, 32); buf.set(block, 64);
  new DataView(buf.buffer).setBigUint64(96, BigInt(betId), true);
  buf.set(new TextEncoder().encode('timeout'), 104);
  return sha256(buf);
}

export function assertOutcome(view: BetResultView, txHash: string): BetResult {
  const client = hexToBytes(view.client_seed);
  const chain = hexToBytes(view.chain_seed);
  const timeout = view.via === 'timeout';
  const server = timeout ? new Uint8Array(32) : hexToBytes(view.server_seed);
  const digest = timeout
    ? hashTimeout(client, chain, hexToBytes(view.block_seed), view.bet_id)
    : hashReveal(server, client, chain, view.bet_id);
  const draws = drawsOf(digest);
  const game = view.game.toLowerCase();
  const outcome: BetResult['outcome'] = {};
  let ok = true;
  if (game === 'slots') {
    const got = resolveSlots(draws);
    outcome.reels = got.reels;
    ok = (view.outcome.reels ?? []).join() === got.reels.join();
  } else if (game === 'coin') {
    outcome.side = resolveCoin(draws);
    ok = view.outcome.side === outcome.side;
  } else if (game === 'dice') {
    const got = resolveDice(draws, 0);
    outcome.dice = got.dice;
    ok = (view.outcome.dice ?? []).join() === got.dice.join();
  } else if (game === 'roulette') {
    const got = resolveRoulette(draws, view.outcome.n ?? 0);
    outcome.n = got.n; outcome.color = got.color;
    ok = view.outcome.n === got.n && view.outcome.color === got.color;
  } else if (game === 'wheel') {
    const prize = pickWeighted(WHEEL_PRIZES, draws[0]!);
    ok = view.outcome.prize === prize;
  } else if (game === 'harmony') {
    const prize = pickWeighted(HARMONY_PRIZES, draws[0]!);
    ok = view.outcome.prize === prize;
  } else if (game === 'blackjack') {
    const player = view.outcome.reels ?? [];
    const dealer = view.outcome.dealer_cards ?? [];
    outcome.reels = player;
    if (!timeout && (view.shoe?.length ?? 0) > 0) {
      const names = shoeNames((view.shoe ?? []).map((hex) => hexToBytes(hex)), client, chain, BigInt(view.bet_id));
      ok = names.join() === dealtOrder(player, dealer).join();
    }
  }
  const proof = { serverSeed: timeout ? '' : view.server_seed, clientSeed: view.client_seed, chainSeed: view.chain_seed, txHash };
  if (!ok) {
    console.error('bet verify failed', proof, view);
    throw new BackendError('verify', 'Result mismatch, please report this bet');
  }
  const chip = 10n ** 22n;
  const wager = Number(BigInt(view.wager) / chip);
  const payout = Number(BigInt(view.payout) / chip);
  const blessing = Number(BigInt(view.blessing) / chip);
  const uiGame = game === 'coin' ? 'coinflip' : game;
  return {
    betId: view.bet_id,
    game: (uiGame === 'wheel' || uiGame === 'harmony' ? 'slots' : uiGame) as BetResult['game'],
    wager, payout, net: payout - wager, blessing, luckGain: view.luck_gain_milli / 1000,
    outcome, proof,
  };
}

function dealtOrder(player: string[], dealer: string[]): string[] {
  const out: string[] = [];
  if (player[0]) out.push(player[0]);
  if (dealer[0]) out.push(dealer[0]);
  if (player[1]) out.push(player[1]);
  for (const card of player.slice(2)) out.push(card);
  for (const card of dealer.slice(1)) out.push(card);
  return out;
}

function shoeNames(seeds: Uint8Array[], client: Uint8Array, chain: Uint8Array, betId: bigint): string[] {
  const ranks = 'A23456789TJQK';
  const suits = 'CDHS';
  const deck = Array.from({ length: 52 }, (_, i) => i);
  return seeds.map((seed, n) => {
    const buf = new Uint8Array(105);
    buf.set(seed, 0); buf.set(client, 32); buf.set(chain, 64);
    new DataView(buf.buffer).setBigUint64(96, betId, true);
    buf[104] = n;
    const h = sha256(buf);
    const draw = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(0, true);
    const j = Math.floor((draw * (52 - n)) / 4294967296);
    const tmp = deck[n]!;
    deck[n] = deck[n + j]!;
    deck[n + j] = tmp;
    const card = deck[n]!;
    return ranks[card % 13]! + suits[Math.floor(card / 13)]!;
  });
}
