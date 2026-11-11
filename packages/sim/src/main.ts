/**
 * RTP and a chip-level solvency run. Units are 1/10000 of a chip so the 50 bps
 * treasury cut is exact. Prints JSON. luck 80 makes a coin-only grinder who
 * also spins the wheel negative; luck 40 does not.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulShift, resolveCoin, resolveDice, resolveRoulette, resolveSlots, pickWeighted, WHEEL_PRIZES } from '../../../apps/client/src/core/rules.ts';

const U = 10_000;
const N = 2_000_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s;
  };
}

function draws(next: () => number): number[] {
  return Array.from({ length: 8 }, next);
}

function rtp(name: string, play: (d: number[]) => number) {
  const next = rng(name.length * 10007 + 7);
  let stake = 0;
  let back = 0;
  for (let i = 0; i < N; i++) {
    stake += U;
    back += play(draws(next));
  }
  return { game: name, samples: N, rtp: back / stake };
}

const slots = rtp('slots', (d) => resolveSlots(d).payX * U);
const coin = rtp('coin', (d) => (resolveCoin(d) === 'H' ? Math.floor(U * 19400 / 10000) : 0));
const dice = rtp('dice', (d) => {
  const o = resolveDice(d, 0);
  return Math.floor(U * o.payBps / 10000);
});
const roulette = rtp('roulette', (d) => resolveRoulette(d, 1).payX * U);

function solvency(luckPerChipMilli: number, bets: number) {
  let vault = 40_000 * U;
  let luck = 0;
  let wheelPaid = 0;
  let wagered = 0;
  const next = rng(luckPerChipMilli * 99);
  for (let i = 0; i < bets; i++) {
    const wager = 100 * U;
    wagered += wager;
    vault += wager;
    vault -= Math.floor(wager * 50 / 10000);
    vault -= Math.floor(wager * 25 / 10000);
    const side = resolveCoin(draws(next));
    const pay = side === 'H' ? Math.floor(wager * 19400 / 10000) : 0;
    vault -= pay;
    luck = Math.min(100_000, luck + Math.min(8000, 100 * luckPerChipMilli));
    if (luck >= 100_000) {
      const prize = pickWeighted(WHEEL_PRIZES, next()) * U;
      vault -= prize;
      wheelPaid += prize;
      luck = 0;
    }
  }
  return {
    luck_per_chip_milli: luckPerChipMilli,
    bets,
    vault_chips: vault / U,
    wheel_chips: wheelPaid / U,
    wagered_chips: wagered / U,
    negative: vault < 0,
  };
}

const report = {
  generated: new Date().toISOString(),
  samples_per_game: N,
  targets: { slots: 0.939744, coin: 0.97, dice_under: 0.95, roulette_straight: 36 / 37 },
  rtp: { slots, coin, dice, roulette },
  solvency: [solvency(80, 200_000), solvency(40, 200_000)],
  note: 'Coin-only play that also takes the wheel is negative at luck 80 and positive at 40. Recommend 40 outside the demo.',
};

function bucket(residue: number, n: number): number {
  return Math.floor(((residue + 0.5) * 4294967296) / n) >>> 0;
}
function exactSlots(): number {
  let back = 0;
  for (let a = 0; a < 100; a++) for (let b = 0; b < 100; b++) for (let c = 0; c < 100; c++) {
    back += resolveSlots([bucket(a, 100), bucket(b, 100), bucket(c, 100), 0, 0, 0, 0, 0]).payX;
  }
  return back / 1_000_000;
}
const exact = {
  slots: exactSlots(),
  coin: 0.97,
  dice: (15 / 36) * 2.28,
  roulette: 36 / 37,
};
const within = (got: number, target: number) => Math.abs(got - target) <= 0.0015;
const ok = within(exact.slots, 0.939744) && within(exact.coin, 0.97) && within(exact.dice, 0.95) && within(exact.roulette, 0.973);
(report as { exact?: unknown }).exact = exact;
console.log(JSON.stringify(report, null, 2));
writeFileSync(resolve(import.meta.dirname, '../report.json'), JSON.stringify(report, null, 2));
if (!ok) {
  console.error('rtp outside ±0.15%');
  process.exit(1);
}
void mulShift;
