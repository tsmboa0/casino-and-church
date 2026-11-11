import type Phaser from 'phaser';
import { WORLD_W, WORLD_H, type Realm } from '../config';
import { input } from '../core/input';
import { findPath } from './pathfind';
import type { CollisionGrid } from './collision';
import type { Bubble, Marker, Npc, Player } from './entities';

const T = 16;
/** wp = index into the realm's route; -1 = speak where the host stands. mark = what to point the ring at (tiles) */
export interface TourStop { wp: number; lines: string[]; face?: 'up' | 'down' | 'left' | 'right'; gesture?: 'point_up' | 'point_left' | 'point_right'; mark?: [number, number] }

export const CASINO_STOPS: TourStop[] = [
  { wp: -1, lines: ['Welcome to the Casino, {name}.', "I'm Don Fortuna. I own the house. Follow me and I'll show you around."] },
  { wp: 1, gesture: 'point_up', mark: [34, 6], lines: ['The Cashier, right by the door. Buy chips here, cash out whenever you like.', "Don't tell the Church how much we keep."] },
  { wp: 2, gesture: 'point_up', mark: [26, 3], lines: ['The slots. Lucky Seven pays a hundred to one.', 'Every bet you place builds your LUCK.'] },
  { wp: 3, gesture: 'point_up', mark: [19.5, 5], lines: ['The Wheel of Fortune. Fill your LUCK to 100 and it spins for you.', 'Or take your LUCK to the Church. Choose wisely.'] },
  { wp: 4, gesture: 'point_up', mark: [34.5, 15], lines: ['The Coin Flip Pit. Heads or tails, nothing hidden.', 'Every flip is dealt by my own wallet. Check it on-chain.'] },
  { wp: 5, gesture: 'point_up', mark: [21.5, 15], lines: ['Roulette. Red, black, or one number for thirty-six to one.'] },
  { wp: 6, gesture: 'point_up', mark: [34.5, 24], lines: ['The Dice Den. Under seven, over seven, or the lucky seven itself.'] },
  { wp: 7, gesture: 'point_up', mark: [20, 24.5], lines: ["Founders' Row. Earn your standing and one of these plots is yours.", 'Your name on the deed, your machine on my floor.'] },
  { wp: 10, face: 'up', gesture: 'point_up', mark: [2, 7.6], lines: ['The House Monitor. The vault, the table limits, every rule I set, live.', 'I run this house myself, every ten minutes. Every decision is signed and put on chain. Walk up and check me.'] },
  { wp: 9, face: 'down', mark: [4.5, 4], lines: ['And this is my office. Knock any time: talk to me about the house.', 'Stay in here too long and your FAITH fades. The Harmony Wheel waits at the Crossroads.'] },
];
export const CHURCH_STOPS: TourStop[] = [
  { wp: -1, lines: ['Peace be with you, {name}.', 'I am Father Nakamoto. Walk with me and I will show you the Church.'] },
  { wp: 1, gesture: 'point_up', mark: [51, 14], lines: ['The Offering Box. Tithe your chips and your FAITH grows.', 'A little of every Casino wager ends up here. We return it as blessings.'] },
  { wp: 2, gesture: 'point_up', mark: [51.5, 3.5], lines: ['The votive candles. Light one each day and your FAITH deepens.', 'The longer you linger here, the more your LUCK runs dry.'] },
  { wp: 3, gesture: 'point_left', mark: [48, 6], lines: ['The Quest Board. Simple deeds, honest rewards.'] },
  { wp: 4, gesture: 'point_up', mark: [65.5, 3.5], lines: ['The Altar. Offer your LUCK and it becomes FAITH.', 'When both burn above fifty, the Harmony Wheel at the Crossroads will turn for you.'] },
  { wp: 5, gesture: 'point_up', mark: [81, 12.5], lines: ['The Scriptorium. Our whitepapers are kept here, as scripture.'] },
  { wp: 6, gesture: 'point_up', mark: [79, 26], lines: ["The Pilgrims' Hall. Rest, eat, and hear the faithful argue about tomorrow."] },
  { wp: 8, face: 'down', mark: [81.5, 3.5], lines: ['My sanctum. The Ledger beside my door holds the treasury and my sermons.', 'I tend this Church myself: Vigils, alms for the poor, the blessings. Every choice is signed and on chain.', 'The Word at the Crossroads shows what Don Fortuna and I are up to. Balance is survival, wanderer.'] },
];

export interface TourCtx {
  scene: Phaser.Scene; guide: Npc; player: Player; bubble: Bubble; marker: Marker; grid: CollisionGrid;
  realm: Realm; route: { x: number; y: number }[]; stops: TourStop[]; name: string; hostName: string;
  isCancelled: () => boolean;
  onStop?: (i: number, n: number) => void;
}

/** distances in px */
const NEAR = 70;       // player must be this close for the host to speak
const FOLLOW = 130;    // the host keeps walking only while the player is this close
const LOST = 300;      // beyond this the host stops talking and waits

const until = (scene: Phaser.Scene, fn: () => boolean) => new Promise<void>(res => {
  if (fn()) return res();
  const h = () => { if (fn()) { scene.events.off('update', h); res(); } };
  scene.events.on('update', h);
});
const wait = (scene: Phaser.Scene, ms: number) => new Promise<void>(res => scene.time.delayedCall(ms, () => res()));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

const CALLOUTS = ['This way, {name}!', 'Over here, {name}. Keep up.', "Don't wander off, {name}.", 'I can wait. But only for you, {name}.', 'Come on, {name}. There is more to see.'];

/**
 * A guided tour that is real: the host only moves while you follow, only speaks when you are close,
 * and waits (calling you back) if you go somewhere else. It never carries on without you.
 * Resolves true when finished, false when cancelled.
 */
export async function runTour(c: TourCtx): Promise<boolean> {
  const { scene, guide, player, grid } = c;
  guide.busy = true;
  let lastCall = 0, callIdx = 0;
  let shown = 0;                       // which message is in the bubble (call-outs and stop lines take turns)
  const callout = () => {
    const now = scene.time.now;
    if (now - lastCall < 6500 || c.bubble.isTyping) return;
    lastCall = now;
    const mine = ++shown;
    c.bubble.show(guide, c.hostName, CALLOUTS[callIdx++ % CALLOUTS.length].replace('{name}', c.name));
    // close only this call-out: if the host has started explaining a stop meanwhile, leave that line alone
    // (this timer used to close whatever was showing, cutting stop lines short when the player had lagged behind)
    scene.time.delayedCall(2600, () => { if (shown === mine && !c.isCancelled()) c.bubble.hide(); });
  };
  const near = (r: number) => dist(player, guide) < r;

  for (let i = 0; i < c.stops.length; i++) {
    if (c.isCancelled()) break;
    const stop = c.stops[i];
    c.onStop?.(i, c.stops.length);
    c.marker.hide();

    if (stop.wp >= 0) {
      const path = findPath(grid, { x: guide.x, y: guide.y }, c.route[stop.wp], WORLD_W, WORLD_H);
      const walking = guide.walk(path, 54);
      if (stop.mark) c.marker.show(stop.mark[0] * T + 8, stop.mark[1] * T);
      // the host walks only while the player is following; otherwise stops and calls them back
      const watch = () => {
        const far = !near(FOLLOW);
        guide.paused = far;
        if (far) callout();
      };
      scene.events.on('update', watch);
      await Promise.race([walking, until(scene, () => c.isCancelled())]);
      scene.events.off('update', watch);
      guide.paused = false;
      if (c.isCancelled()) break;
      guide.stopWalking();
      // arrived: wait for the player to catch up (as long as it takes)
      if (!near(NEAR)) {
        const w2 = () => { if (!near(NEAR)) callout(); };
        scene.events.on('update', w2);
        await until(scene, () => c.isCancelled() || near(NEAR));
        scene.events.off('update', w2);
      }
    }
    if (c.isCancelled()) break;
    guide.look(stop.face ?? 'down', false);
    if (stop.mark && stop.wp < 0) c.marker.show(stop.mark[0] * T + 8, stop.mark[1] * T);
    if (stop.gesture) { guide.gesture(stop.gesture); await wait(scene, 350); }

    for (const line of stop.lines) {
      if (c.isCancelled()) break;
      // never speak to an empty room
      await until(scene, () => c.isCancelled() || near(LOST));
      shown++;
      c.bubble.show(guide, c.hostName, line.replace('{name}', c.name));
      guide.gesture('talk');
      await until(scene, () => c.isCancelled() || !c.bubble.isTyping || input.pressed('interact'));
      c.bubble.skipTyping();
      guide.look(guide.facing, false);
      input.clearEdges();
      // hold: advance on a tap, or after a read-time *while the player is still with us*
      let read = 0;
      const tick = (_t: number, dt: number) => { if (near(NEAR * 2.2)) read += dt; };
      scene.events.on('update', tick);
      const need = 1400 + line.length * 36;
      await until(scene, () => c.isCancelled() || input.pressed('interact') || read > need);
      scene.events.off('update', tick);
      c.bubble.hide();
    }
  }
  c.marker.hide(); c.bubble.hide();
  guide.paused = false; guide.busy = false;
  return !c.isCancelled();
}
