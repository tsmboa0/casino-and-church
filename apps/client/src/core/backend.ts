import { CAMPAIGN_LIMITS, campaignCost, campaignProblem, type NewCampaign } from '@cnc/shared';
import { store, type Plot, type HistRow } from './state';
import { bus } from './bus';
import {
  PARAMS, CHIPS_PER_NEAR, QUESTS, PLOT_GATE, PLOT_MIN_BANKROLL, WHEEL_PRIZES, HARMONY_PRIZES, COIN_PAY_BPS,
  randomDraws, resolveSlots, resolveCoin, resolveDice, resolveRoulette, pickWeighted, cardName, handTotal, tenOrAce, blackjackPayout,
  withBlessing, luckForBet, faithForTithe, blessingOf,
} from './rules';

/**
 * THE INTEGRATION SEAM (BACKEND_PLAN.md §3).
 * Every panel talks to `backend`, never to the store directly. `MockBackend` runs the same rules locally;
 * `ChainBackend` (to be written) implements the same interface against the `realm` contract. Every call
 * resolves with the authoritative result; the store is refreshed from the returned player snapshot.
 */
import { BackendError } from './errors';
import { faqAnswer, HOST_REFUSAL } from '@cnc/shared';
export { BackendError };

export type Game = 'slots' | 'coinflip' | 'dice' | 'roulette' | 'blackjack';
export interface BetReq { game: Game; wager: number; pick?: number; machineId?: number }
export interface BetResult {
  betId: number; game: Game; wager: number; payout: number; net: number; blessing: number; luckGain: number;
  outcome: { reels?: string[]; side?: 'H' | 'T'; dice?: [number, number]; n?: number; color?: string };
  proof?: { serverSeed: string; clientSeed: string; chainSeed: string; txHash: string };   // chain mode only
}
export interface WheelResult { prize: number | 'JACKPOT'; chips: number }
/** a blackjack hand as the panel draws it (chain: built from get_blackjack + the settled result) */
export interface BjState {
  betId: number; stage: 'player' | 'done'; player: string[]; dealer: string[];
  playerTotal: number; dealerTotal: number; soft: boolean; doubled: boolean; stake: number; canDouble: boolean;
  result?: { label: 'natural' | 'win' | 'push' | 'lose'; payout: number; blessing: number };
}
// ---- the two AI hosts (BACKEND_PLAN.md R3-6) ----
export type AgentId = 'fortuna' | 'nakamoto';
export interface CampaignRow {
  id: number; kind: number; creator: string; title: string; url: string; machineId: number; goal: number;
  rewardChips: number; rewardFaith: number; maxClaims: number; claims: number; active: boolean; claimed: boolean; progress: number; mine: boolean;
}
export interface AgentProof { model: string; chatId: string; signedText: string; signature: string; signingAddress: string;
  signatureKind: 'provider_tee' | 'gateway'; requestB64: string; responseB64: string; attestedSigner: string; attestationAt: number; txHash?: string }
export interface AgentDecision { id: string; agent: AgentId; at: number; action: string; params: Record<string, number | string>;
  line: string; applied: boolean; reason?: string; txHash?: string; proof?: AgentProof; policy?: 'llm' | 'rules' }
export interface RealmEvent { kind: 'happy_hour' | 'vigil'; realm: 'casino' | 'church'; endsAt: number; boostBps: number; by: AgentId }
export interface HouseStats { playersOnline: number; inCasino: number; inChurch: number; inPlaza: number; volume24h: number; houseNet24h: number;
  vault: number; vaultFree: number; jackpot: number; maxBet: number; luckPerChipMilli: number; edgeRealized24h: number; edgeExpected: number;
  biggestWin24h: { name: string; chips: number; game: string } | null; timeouts24h: number }
export interface ChurchStats { treasury: number; tithes24h: number; candles24h: number; alms24h: number; blessingsPaid24h: number;
  blessingCapBps: number; candleFaithMilli: number; faithfulOnline: number }
export interface LbRow { rank: number; name: string; wagered: number; net: number; you?: boolean }
export interface Backend {
  readonly mode: 'mock' | 'chain';
  placeBet(r: BetReq): Promise<BetResult>;                       // resolves when the bet is SETTLED (reveal done)
  spinWheel(): Promise<WheelResult>;                             // needs LUCK 100
  spinHarmony(): Promise<WheelResult>;                           // needs LUCK >= 50 and FAITH >= 50, cooldown
  tithe(chips: number): Promise<{ faithGain: number }>;
  offerLuck(luck: number): Promise<{ faithGain: number }>;
  lightCandle(): Promise<void>;
  claimQuest(id: string): Promise<void>;
  deposit(near: number): Promise<void>;                          // chain: a direct signed tx WITH attached deposit
  withdraw(chips: number): Promise<void>;
  faucet(): Promise<number | void>;                              // chain: server funds the account; resolves with the NEAR paid
  enterRealm(realm: 'casino' | 'church' | 'plaza'): Promise<void>;
  claimPlot(id: number, name: string, skin: string, bankroll: number): Promise<Plot>;
  fundMachine(id: number, chips: number): Promise<void>;
  withdrawMachine(id: number, chips: number): Promise<void>;
  /** OPTIONAL blackjack (contract: place_bet("blackjack") then blackjack_act). Resolves once the opening cards are shown
   *  (stage 'player'), or 'done' straight away on a natural. */
  blackjackDeal?(wager: number): Promise<BjState>;
  /** hit keeps stage 'player' unless it busts or makes 21; stand/double resolve only after the dealer has finished (stage 'done') */
  blackjackAct?(betId: number, action: 'hit' | 'stand' | 'double'): Promise<BjState>;
  /** OPTIONAL: the AI hosts (R3-6). The mock simulates them with the rule policy, unsigned. */
  agentFeed?(agent: AgentId | 'all', limit?: number): Promise<AgentDecision[]>;
  /** OPTIONAL: talk to a host. Only game questions are answered; anything else gets an in-character refusal (relevant=false).
   *  Chain: POST /agent/ask (R3-9). The answer can carry the same signed proof as a decision. */
  askHost?(agent: AgentId, question: string): Promise<{ answer: string; relevant: boolean; proof?: AgentProof }>;
  agentProof?(id: string): Promise<AgentProof>;
  activeEvents?(): Promise<RealmEvent[]>;
  houseStats?(): Promise<HouseStats>;
  churchStats?(): Promise<ChurchStats>;
  /** OPTIONAL: relayed set_profile / complete_tour (the client calls them fire-and-forget) */
  setProfile?(name: string, avatar: string): Promise<void>;
  /** OPTIONAL (usernames are unique, held by the server): is this name free for me? */
  checkName?(name: string): Promise<{ available: boolean; reason?: string }>;
  /** OPTIONAL: Church campaigns (the open Mission Board). Social/project tasks are attested by the Church oracle. */
  campaigns?(): Promise<CampaignRow[]>;
  startCampaign?(id: number): Promise<{ visitS: number }>;
  claimCampaign?(id: number): Promise<{ chips: number; faith: number }>;
  createCampaign?(c: NewCampaign): Promise<number>;
  closeCampaign?(id: number): Promise<void>;
  /** OPTIONAL: re-read balances from the chain before acting on them */
  sync?(): Promise<void>;
  /** OPTIONAL: this device's guest wallet (chain mode) */
  wallet?(): Promise<{ accountId: string; encrypted: boolean }>;
  completeTour?(realm: 'casino' | 'church'): Promise<void>;
  /** OPTIONAL (added 10 Nov for the cashier tabs): the player's last plays, newest first. Chain: GET /bets?account= */
  history?(): Promise<HistRow[]>;
  /** OPTIONAL: top players by chips wagered. Chain: GET /leaderboard. */
  leaderboard?(): Promise<{ rows: LbRow[]; demo: boolean }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fail = (code: string, msg: string): never => { throw new BackendError(code, msg); };

class MockBackend implements Backend {
  readonly mode = 'mock' as const;
  private timer = window.setInterval(() => { this.settle(); this.agentTick(); }, 4000);
  stop() { window.clearInterval(this.timer); }

  /** lazy decay, exactly as the contract does it: only the meter of the realm you are NOT in decays */
  private settle() {
    const s = store.stats, now = Date.now();
    const dt = Math.min((now - s.settledAt) / 1000, PARAMS.maxDecayWindowS); s.settledAt = now;
    const d = (dt / 60) * (PARAMS.decayPerMinMilli / 1000);
    if (d > 0) {
      if (store.realm === 'casino') store.eco.faith = Math.max(0, store.eco.faith - d);
      else if (store.realm === 'church') store.eco.luck = Math.max(0, store.eco.luck - d);
      store.saveEco(); store.emit();
    }
  }
  private log(game: string, wager: number, payout: number, detail: string) {
    const s = store.stats; s.net += payout - wager;
    s.history.unshift({ t: Date.now(), game, wager, payout, detail }); s.history.length = Math.min(s.history.length, 40); store.saveEco();
  }
  private faith(n: number) { store.change({ faith: n }); if (n > 0) store.stats.faithEarned += n; }

  async placeBet(r: BetReq): Promise<BetResult> {
    this.settle();
    const e = store.eco, s = store.stats;
    if (r.game === 'blackjack') fail('bad_args', 'The blackjack table is closed in the demo.');
    if (!PARAMS.quoteBets.includes(r.wager) && r.game !== 'roulette') fail('bad_wager', 'Pick one of the listed bets.');
    if (r.wager < 1 || e.chips < r.wager) fail('no_chips', 'Not enough chips. Visit the Cashier.');
    const draws = randomDraws(), betId = s.nextBet++;
    let base = 0, outcome: BetResult['outcome'] = {};
    if (r.game === 'slots') { const o = resolveSlots(draws); base = r.wager * o.payX; outcome = { reels: o.reels }; s.spins++; }
    else if (r.game === 'coinflip') { const side = resolveCoin(draws); outcome = { side }; if ((r.pick === 0 ? 'H' : 'T') === side) base = Math.floor((r.wager * COIN_PAY_BPS) / 10000); s.flips++; }
    else if (r.game === 'dice') { const o = resolveDice(draws, r.pick ?? 0); base = Math.floor((r.wager * o.payBps) / 10000); outcome = { dice: o.dice }; s.dice++; }
    else { const o = resolveRoulette(draws, r.pick ?? 100); base = r.wager * o.payX; outcome = { n: o.n, color: o.color }; s.roulette++; }
    const blessed = base > 0 ? withBlessing(base, e.faith) : 0;
    const luckGain = luckForBet(r.wager) * this.boost('casino');
    s.wagered += r.wager;
    s.pool += (r.wager * PARAMS.treasuryBpsOfWager) / 10000; s.jackpot += (r.wager * PARAMS.jackpotBpsOfWager) / 10000;
    store.change({ chips: -r.wager + blessed, luck: luckGain });
    const o = outcome, detail = o.reels ? o.reels.map(x => x.toUpperCase()).join(' ') : o.side ? (o.side === 'H' ? 'HEADS' : 'TAILS') : o.dice ? `${o.dice[0]} + ${o.dice[1]} = ${o.dice[0] + o.dice[1]}` : `${o.n} ${String(o.color).toUpperCase()}`;
    this.log(r.game, r.wager, blessed, detail);
    await sleep(350);                                               // stands in for commit -> reveal latency
    return { betId, game: r.game, wager: r.wager, payout: blessed, net: blessed - r.wager, blessing: blessed - base, luckGain, outcome };
  }

  async spinWheel(): Promise<WheelResult> {
    this.settle(); if (store.eco.luck < 100) fail('luck', 'Your LUCK must be full (100).');
    const prize = pickWeighted(WHEEL_PRIZES, randomDraws()[0]);
    store.change({ luck: -100, chips: prize }); this.log('wheel', 0, prize, `WHEEL ${prize}`); await sleep(250); return { prize, chips: prize };
  }
  async spinHarmony(): Promise<WheelResult> {
    this.settle(); const e = store.eco, s = store.stats;
    if (e.luck < 50 || e.faith < 50) fail('harmony', 'Harmony needs 50 LUCK and 50 FAITH.');
    const wait = s.harmonyAt + PARAMS.harmonyCooldownS * 1000 - Date.now();
    if (wait > 0) fail('cooldown', `The wheel rests for ${Math.ceil(wait / 1000)}s.`);
    const prize = pickWeighted(HARMONY_PRIZES, randomDraws()[0]);
    const chips = prize === 'JACKPOT' ? Math.floor(s.jackpot) : prize;
    if (prize === 'JACKPOT') s.jackpot -= chips;
    s.harmonyAt = Date.now(); store.change({ luck: -PARAMS.harmonyCostMilli / 1000, faith: -PARAMS.harmonyCostMilli / 1000, chips });
    this.log('harmony', 0, chips, prize === 'JACKPOT' ? 'JACKPOT' : `HARMONY ${chips}`);
    await sleep(250); return { prize, chips };
  }
  async tithe(chips: number) {
    this.settle(); if (chips < 10) fail('min', 'The minimum tithe is 10 chips.'); if (store.eco.chips < chips) fail('no_chips', 'Not enough chips.');
    const g = faithForTithe(chips, store.eco.faith) * this.boost('church');
    store.stats.tithed += chips; store.stats.pool += chips; store.change({ chips: -chips }); this.faith(g); return { faithGain: g };
  }
  async offerLuck(luck: number) {
    this.settle(); if (luck < 1 || store.eco.luck < luck) fail('luck', 'Not enough LUCK to offer.');
    const g = (luck * PARAMS.offerRatioBps) / 10000; store.stats.converted += luck; store.change({ luck: -luck }); this.faith(g); return { faithGain: g };
  }
  async lightCandle() {
    this.settle(); const wait = store.stats.candleAt + PARAMS.candleCooldownS * 1000 - Date.now();
    if (wait > 0) fail('cooldown', `Wait ${Math.ceil(wait / 1000)}s.`);
    store.stats.candles++; store.stats.candleAt = Date.now(); this.faith((PARAMS.candleFaithMilli / 1000) * this.boost('church'));
  }
  async claimQuest(id: string) {
    const q = QUESTS.find((x) => x.id === id); if (!q) return fail('quest', 'Unknown quest.');
    if (store.stats.claimed[id]) fail('claimed', 'Already claimed.');
    if (store.stats[q.counter] < q.goal) fail('progress', 'Not finished yet.');
    store.stats.claimed[id] = true;
    store.change({ chips: q.reward.chips ?? 0, luck: q.reward.luck ?? 0 }); if (q.reward.faith) this.faith(q.reward.faith);
  }
  async deposit(near: number) {
    if (near <= 0 || store.eco.near < near) fail('no_near', 'Not enough test NEAR. Use the faucet.');
    store.change({ near: -near, chips: near * CHIPS_PER_NEAR });
  }
  async withdraw(chips: number) {
    const n = Math.floor(Math.min(chips, store.eco.chips) / CHIPS_PER_NEAR); if (n < 1) fail('min', `You need at least ${CHIPS_PER_NEAR} chips to withdraw.`);
    store.change({ chips: -n * CHIPS_PER_NEAR, near: n });
  }
  async faucet() { store.change({ near: 5 }); return 5; }
  async enterRealm() { this.settle(); }

  async claimPlot(id: number, name: string, skin: string, bankroll: number): Promise<Plot> {
    const s = store.stats; name = name.replace(/[^\w '\-]/g, '').trim().slice(0, 16);
    if (store.plots[id]) fail('taken', 'That plot is already owned.');
    if (name.length < 3) fail('name', 'Give the machine a name (3-16 letters).');
    if (s.wagered < PLOT_GATE.wagered || s.faithEarned < PLOT_GATE.faithEarned) fail('gate', `Earn your standing first: wager ${PLOT_GATE.wagered} chips (${Math.floor(s.wagered)} so far) and earn ${PLOT_GATE.faithEarned} FAITH (${Math.floor(s.faithEarned)} so far).`);
    if (bankroll < PLOT_MIN_BANKROLL) fail('bankroll', `The machine needs at least ${PLOT_MIN_BANKROLL} chips of bankroll.`);
    if (store.eco.chips < bankroll) fail('no_chips', 'Not enough chips for that bankroll.');
    store.change({ chips: -bankroll });
    const p: Plot = { id, owner: store.profile?.username ?? 'you', name, skin, bankroll, plays: 0, earned: 0, deed: `deed:machine:${id}` };
    store.plots[id] = p; store.saveEco(); store.emit(); bus.emit('plotsChanged'); return p;
  }
  // ---- blackjack (one deck, dealer stands on all 17s, natural pays 3:2, double on two cards, no split)
  private bj: { id: number; deck: number[]; player: number[]; dealer: number[]; original: number; stake: number; doubled: boolean } | null = null;
  private bjView(done?: BjState['result']): BjState {
    const h = this.bj!, p = handTotal(h.player), d = handTotal(h.dealer);
    return { betId: h.id, stage: done ? 'done' : 'player', player: h.player.map(cardName), dealer: h.dealer.map(cardName), playerTotal: p.total, dealerTotal: d.total, soft: p.soft, doubled: h.doubled, stake: h.stake, canDouble: !done && h.player.length === 2 && !h.doubled && store.eco.chips >= h.original, result: done };
  }
  private bjFinish(dealerPlays: boolean): BjState {
    const h = this.bj!;
    if (dealerPlays) while (handTotal(h.dealer).total < 17) h.dealer.push(h.deck.pop()!);
    const r = blackjackPayout(h.player, h.dealer, h.original, h.stake);
    const paid = r.label === 'win' || r.label === 'natural' ? withBlessing(r.pay, store.eco.faith) : r.pay;
    const s = store.stats; s.wagered += h.stake; s.pool += (h.stake * PARAMS.treasuryBpsOfWager) / 10000; s.jackpot += (h.stake * PARAMS.jackpotBpsOfWager) / 10000;
    store.change({ chips: paid, luck: luckForBet(h.stake) });
    this.log('blackjack', h.stake, paid, `${h.player.map(cardName).join(' ')} v ${h.dealer.map(cardName).join(' ')}`);
    const v = this.bjView({ label: r.label, payout: paid, blessing: paid - r.pay }); this.bj = null; return v;
  }
  async blackjackDeal(wager: number): Promise<BjState> {
    this.settle();
    if (this.bj) fail('busy', 'Finish the hand on the table first.');
    if (!PARAMS.quoteBets.includes(wager)) fail('bad_wager', 'Pick one of the listed bets.');
    if (store.eco.chips < wager) fail('no_chips', 'Not enough chips. Visit the Cashier.');
    const deck = Array.from({ length: 52 }, (_, i) => i), rnd = new Uint32Array(52); crypto.getRandomValues(rnd);
    for (let i = 51; i > 0; i--) { const j = rnd[i] % (i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    store.change({ chips: -wager });
    const h = { id: store.stats.nextBet++, deck, player: [] as number[], dealer: [] as number[], original: wager, stake: wager, doubled: false };
    h.player.push(deck.pop()!); h.dealer.push(deck.pop()!); h.player.push(deck.pop()!);   // player, upcard, player (no hole card yet)
    this.bj = h; await sleep(300);
    if (handTotal(h.player).total === 21) {                         // natural: paid now unless the upcard could also make one
      if (tenOrAce(h.dealer[0])) h.dealer.push(deck.pop()!);
      return this.bjFinish(false);
    }
    return this.bjView();
  }
  async blackjackAct(betId: number, action: 'hit' | 'stand' | 'double'): Promise<BjState> {
    const h = this.bj; if (!h || h.id !== betId) return fail('unknown_bet', 'That hand is over.');
    await sleep(250);
    if (action === 'double') {
      if (h.player.length !== 2 || h.doubled) fail('bad_args', 'You can only double on your first two cards.');
      if (store.eco.chips < h.original) fail('no_chips', 'Not enough chips to double.');
      store.change({ chips: -h.original }); h.stake += h.original; h.doubled = true; h.player.push(h.deck.pop()!);
      return this.bjFinish(handTotal(h.player).total <= 21);
    }
    if (action === 'hit') {
      h.player.push(h.deck.pop()!);
      const t = handTotal(h.player).total;
      if (t > 21) return this.bjFinish(false);
      if (t === 21) return this.bjFinish(true);
      return this.bjView();
    }
    return this.bjFinish(true);
  }

  // ---- the AI hosts, simulated offline with the same rule policy the server falls back to (unsigned) ----
  private feed: AgentDecision[] = [];
  private events: RealmEvent[] = [];
  private lastEventAt: Record<'casino' | 'church', number> = { casino: 0, church: 0 };
  private nextDecisionAt = Date.now() + 25000;
  private turn: AgentId = 'fortuna';
  private boost(realm: 'casino' | 'church') { const e = this.events.find(x => x.realm === realm && x.endsAt > Date.now()); return e ? 1 + e.boostBps / 10000 : 1; }
  private agentTick() {
    const now = Date.now();
    const before = this.events.length; this.events = this.events.filter(e => e.endsAt > now);
    if (this.events.length !== before) bus.emit('eventsChanged');
    if (now < this.nextDecisionAt) return;
    this.nextDecisionAt = now + 75000;                               // demo cadence; the server decides every 10 minutes
    const a = this.turn; this.turn = a === 'fortuna' ? 'nakamoto' : 'fortuna';
    const realm = a === 'fortuna' ? 'casino' : 'church';
    const quietSince = now - this.lastEventAt[realm];
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    let d: AgentDecision;
    const id = `demo-${now}`;
    if (!this.events.some(e => e.realm === realm) && quietSince > 4 * 60000 && Math.random() < 0.65) {
      const minutes = 3, boostBps = pick([2000, 2500, 3000]);         // demo: short events so a judge sees one start and end
      this.events.push({ kind: a === 'fortuna' ? 'happy_hour' : 'vigil', realm, endsAt: now + minutes * 60000, boostBps, by: a });
      this.lastEventAt[realm] = now; bus.emit('eventsChanged');
      d = { id, agent: a, at: now, action: a === 'fortuna' ? 'start_happy_hour' : 'start_vigil', params: { minutes, boost_pct: boostBps / 100 }, applied: true,
        line: a === 'fortuna' ? pick(['The floor is too quiet. Happy Hour: every bet fills your LUCK faster.', 'The Father has his candles. I have Happy Hour. Choose wisely.', 'Empty tables make me nervous. LUCK is cheap for the next few minutes.'])
                              : pick(['The dice are loud tonight. A Vigil, children: every candle counts double.', 'Don Fortuna lit his neon. We light candles. Come, the Vigil has begun.', 'A quiet hour for the soul. Tithes and candles grow FAITH faster during the Vigil.']) };
    } else if (a === 'nakamoto' && store.eco.chips < 50 && !store.stats.claimed['alms-today']) {
      store.stats.claimed['alms-today'] = true; store.change({ chips: 30 });
      d = { id, agent: a, at: now, action: 'grant_alms', params: { chips: 30 }, applied: true, line: 'A weary pilgrim came to us with empty pockets. The Church gave 30 chips. Spend them wisely.' };
    } else {
      d = { id, agent: a, at: now, action: 'none', params: {}, applied: true,
        line: a === 'fortuna' ? pick(['The vault is healthy. The house keeps its rules today.', 'Steady night. I watch the screens, you watch the reels.', 'No changes. A good casino is a predictable casino.'])
                              : pick(['The treasury is steady. Blessings flow as promised.', 'Nothing to change tonight. The candles burn on their own.', 'Peace at the altar. The Church keeps its course.']) };
    }
    this.feed.unshift(d); this.feed.length = Math.min(this.feed.length, 30);
    bus.emit('agentDecision', d);
  }
  /** offline: a small in-character FAQ. The server uses NEAR AI with a relevance gate (BACKEND_PLAN R3-9). */
  async askHost(agent: AgentId, question: string) {
    await sleep(500 + Math.random() * 500);
    const hit = faqAnswer(agent, question);
    return hit ? { answer: hit, relevant: true } : { answer: HOST_REFUSAL[agent], relevant: false };
  }
  async agentFeed(agent: AgentId | 'all', limit = 20) { return this.feed.filter(d => agent === 'all' || d.agent === agent).slice(0, limit); }
  async activeEvents() { const now = Date.now(); return this.events.filter(e => e.endsAt > now); }
  async houseStats(): Promise<HouseStats> {
    const day = Date.now() - 86400000, h = store.stats.history.filter(x => x.t > day && x.wager > 0);
    const vol = h.reduce((a, x) => a + x.wager, 0), net = h.reduce((a, x) => a + x.wager - x.payout, 0);
    const best = store.stats.history.filter(x => x.t > day).sort((a, b) => b.payout - a.payout)[0];
    return { playersOnline: 1, inCasino: store.realm === 'casino' ? 1 : 0, inChurch: store.realm === 'church' ? 1 : 0, inPlaza: store.realm === 'plaza' ? 1 : 0,
      volume24h: vol, houseNet24h: net, vault: 40000 + net, vaultFree: 38000 + net, jackpot: Math.floor(store.stats.jackpot), maxBet: 100, luckPerChipMilli: PARAMS.luckPerChipMilli * this.boost('casino'),
      edgeRealized24h: vol ? net / vol : 0, edgeExpected: 0.045, biggestWin24h: best && best.payout > 0 ? { name: store.profile?.username ?? 'You', chips: best.payout, game: best.game } : null, timeouts24h: 0 };
  }
  async churchStats(): Promise<ChurchStats> {
    return { treasury: Math.floor(store.stats.pool), tithes24h: store.stats.tithed, candles24h: store.stats.candles, alms24h: store.stats.claimed['alms-today'] ? 30 : 0,
      blessingsPaid24h: 0, blessingCapBps: 500, candleFaithMilli: PARAMS.candleFaithMilli * this.boost('church'), faithfulOnline: store.realm === 'church' ? 1 : 0 };
  }

  async history() { return store.stats.history.slice(); }

  // ---- campaigns (demo): the same rules as the contract, kept in memory; the Church "oracle" waits 5 s
  private camps: CampaignRow[] = [
    { id: 1, kind: 0, creator: 'admin', title: 'Follow @NEARProtocol on X', url: 'https://x.com/NEARProtocol', machineId: 0, goal: 0, rewardChips: 2, rewardFaith: 3, maxClaims: 50, claims: 12, active: true, claimed: false, progress: 0, mine: false },
    { id: 2, kind: 1, creator: 'admin', title: 'Read how NEAR AI keeps the hosts honest', url: 'https://docs.near.ai/', machineId: 0, goal: 0, rewardChips: 0, rewardFaith: 2, maxClaims: 200, claims: 31, active: true, claimed: false, progress: 0, mine: false },
    { id: 3, kind: 0, creator: 'admin', title: 'Share the game with #NEARHackathon', url: 'https://x.com/intent/post?text=Playing%20The%20Casino%20%26%20The%20Church%20%23NEARHackathon', machineId: 0, goal: 0, rewardChips: 2, rewardFaith: 3, maxClaims: 30, claims: 4, active: true, claimed: false, progress: 0, mine: false },
  ];
  private campStarts = new Map<number, number>();
  async campaigns() { return this.camps.map((c) => ({ ...c })).reverse(); }
  async startCampaign(id: number) { this.campStarts.set(id, Date.now()); return { visitS: 5 }; }
  async claimCampaign(id: number) {
    await sleep(600);
    const c = this.camps.find((x) => x.id === id);
    if (!c || !c.active) fail('closed', 'That campaign has ended.');
    if (c!.claimed) fail('already_claimed', 'You already claimed this one.');
    if (c!.mine) fail('not_allowed', 'You cannot claim your own campaign.');
    const at = this.campStarts.get(id);
    if (!at || Date.now() - at < 5000) fail('not_done', 'Open the task first, then come back.');
    c!.claimed = true; c!.claims++; if (c!.claims >= c!.maxClaims) c!.active = false;
    store.eco.chips += c!.rewardChips; store.eco.faith = Math.min(100, store.eco.faith + c!.rewardFaith); store.emit();
    return { chips: c!.rewardChips, faith: c!.rewardFaith };
  }
  async createCampaign(n: NewCampaign) {
    await sleep(700);
    const problem = campaignProblem(n); if (problem) fail('bad_args', problem);
    if (store.eco.faith < CAMPAIGN_LIMITS.creatorMinFaith) fail('faith_low', `You need FAITH ${CAMPAIGN_LIMITS.creatorMinFaith} to open a campaign.`);
    const cost = campaignCost(n);
    if (store.eco.chips < cost.total) fail('no_chips', `This campaign costs ${cost.total} chips.`);
    store.eco.chips -= cost.total; store.stats.pool += cost.listing; store.emit();
    const id = Math.max(...this.camps.map((c) => c.id)) + 1;
    this.camps.push({ id, kind: n.kind, creator: 'you', title: n.title, url: n.url, machineId: n.machine_id, goal: n.goal, rewardChips: n.reward_chips, rewardFaith: n.reward_faith_milli / 1000, maxClaims: n.max_claims, claims: 0, active: true, claimed: false, progress: 0, mine: true });
    return id;
  }
  async closeCampaign(id: number) {
    const c = this.camps.find((x) => x.id === id);
    if (!c || !c.mine || !c.active) fail('not_allowed', 'Only the creator can close an open campaign.');
    c!.active = false; store.eco.chips += (c!.maxClaims - c!.claims) * c!.rewardChips; store.emit();
  }
  async leaderboard() {
    // until the indexer is live the board is seeded with the house regulars, clearly marked DEMO in the UI
    const rivals = [['HighRollerVic', 48200, 3100], ['LadyLuck', 31750, -2400], ['SaintNakamoto', 22900, 900], ['CardShark', 18400, -5200], ['Songbird', 9600, 1200], ['TheTourist', 4100, -900], ['Pilgrim42', 2300, 300]] as const;
    const me = { name: store.profile?.username ?? 'You', wagered: Math.floor(store.stats.wagered), net: Math.floor(store.stats.net), you: true };
    const rows = [...rivals.map(([name, wagered, net]) => ({ name, wagered, net })), me].sort((a, b) => b.wagered - a.wagered).map((r, i) => ({ rank: i + 1, ...r }));
    return { rows, demo: true };
  }
  async fundMachine(id: number, chips: number) {
    const p = store.plots[id]; if (!p) return fail('none', 'No machine there.'); if (store.eco.chips < chips || chips < 1) fail('no_chips', 'Not enough chips.');
    store.change({ chips: -chips }); p.bankroll += chips; store.saveEco(); store.emit();
  }
  async withdrawMachine(id: number, chips: number) {
    const p = store.plots[id]; if (!p) return fail('none', 'No machine there.');
    if (chips < 1 || p.bankroll - chips < 100) fail('reserve', 'The machine must keep a 100 chip reserve.');
    p.bankroll -= chips; store.change({ chips }); store.saveEco();
  }
}

export let backend: Backend = new MockBackend();

/** Boot hook. Chain mode falls back to the mock when `/healthz` does not answer. */
export async function initBackend(): Promise<string | null> {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  if ((env.VITE_BACKEND ?? 'mock') !== 'chain') return null;
  const { connectChain } = await import('../chain/boot');
  const next = await connectChain(env.VITE_API_URL ?? 'http://localhost:8787');
  if ('offline' in next) return next.offline;
  if (backend instanceof MockBackend) backend.stop();
  backend = next;
  return null;
}

export { blessingOf };
