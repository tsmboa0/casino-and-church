import assert from 'node:assert/strict';
import test from 'node:test';
import { nextTableLimit } from '../src/agent/rules.ts';
import { betDetail } from '../src/indexer/detail.ts';

test('the rule fallback only lowers the table when the vault is thin', () => {
  assert.equal(nextTableLimit(3_000, 10_000, 100, 10), null);        // 30% of the day's high: hold
  assert.equal(nextTableLimit(2_999, 10_000, 100, 10), 80);          // one 20% step down
  assert.equal(nextTableLimit(1, 10_000, 12, 10), 10);               // never below the largest allowed chip
  assert.equal(nextTableLimit(1, 10_000, 10, 10), null);
});

test('history lines match the cashier copy', () => {
  assert.equal(betDetail('Slots', { reels: ['seven', 'coin', 'cross'] }), 'SEVEN COIN CROSS');
  assert.equal(betDetail('Coin', { side: 'H' }), 'HEADS');
  assert.equal(betDetail('Dice', { dice: [3, 4] }), '3 + 4 = 7');
  assert.equal(betDetail('Roulette', { n: 17, color: 'red' }), '17 RED');
  assert.equal(betDetail('Wheel', { prize: 250 }), 'WHEEL 250');
  assert.equal(betDetail('Harmony', { prize: 'JACKPOT' }), 'JACKPOT');
  assert.equal(betDetail('Blackjack', { reels: ['AS', 'KD'], dealer_cards: ['9H', '7C'] }), 'AS KD v 9H 7C');
});
