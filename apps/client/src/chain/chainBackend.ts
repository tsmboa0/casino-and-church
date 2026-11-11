import { CHIP_YOCTO, TGAS, bytesToHex, cleanName, humanError, nameClaimMessage, type NewCampaign } from '@cnc/shared';
import { ed25519 } from '@noble/curves/ed25519';
import { bus } from '../core/bus';
import {
  BackendError, type AgentDecision, type AgentId, type AgentProof, type Backend, type BetReq, type BetResult, type BjState,
  type CampaignRow, type ChurchStats, type HouseStats, type RealmEvent, type WheelResult,
} from '../core/backend';
import { QUESTS, PARAMS, handTotal, setTableBets } from '../core/rules';
import { store, type HistRow, type Plot } from '../core/state';
import { getSession, refreshNonce, wallet } from './auth';
import { relay } from './relay';
import { accountBalance, blockTip, dropView, txEvents, txFailureName, txOk, txPanic, viewCall, waitTx } from './rpc';
import { listen, subscribe } from './sse';
import type { BetResultView, MachineView, PlayerView } from './types';
import { assertOutcome } from './verify';

const CHIP = CHIP_YOCTO;
const questBit = Object.fromEntries(QUESTS.map((q) => [q.bit, q.id]));

export class ChainBackend implements Backend {
  readonly mode = 'chain' as const;
  private welcomeOnce = false;
  private toasted = false;
  private timer = 0;

  constructor(private api: string, private contract: string, private relayer: string) {
    this.timer = window.setInterval(() => this.visualDecay(), 4000);
  }

  private unlisten: () => void = () => {};
  stop() { window.clearInterval(this.timer); this.unlisten(); }

  /**
   * Boot: open (or create) the guest account, read the player and the table limits, and start the live stream.
   * Throws a BackendError the boot screen can show (e.g. the server's daily account quota).
   */
  async init() {
    const session = await this.session();
    await this.loadTable();
    try { await this.refresh(); } catch { /* a brand-new account lands a moment later; the next action refreshes */ }
    void this.ensureWelcome().catch(() => { /* retried before the first bet */ });   // the welcome chips show up right away
    this.unlisten = listen(this.api, session.accountId, {
      agent_decision: (d: AgentDecision) => {
        bus.emit('agentDecision', d);
        if (d.applied && (d.action === 'set_max_bet')) void this.loadTable();
      },
      events_changed: () => bus.emit('eventsChanged'),
    });
  }

  /** the chips the panels offer = the contract's allowed wagers at or under the effective max bet */
  private async loadTable() {
    dropView(this.contract, 'get_params');
    const p = await viewCall(this.contract, 'get_params', {}) as { allowed_wagers?: number[]; effective_max_bet_chips?: number; max_bet_chips?: number } | null;
    if (!p?.allowed_wagers?.length) return;
    const max = Number(p.effective_max_bet_chips ?? p.max_bet_chips ?? Infinity);
    const bets = p.allowed_wagers.map(Number).filter((b) => b <= max);
    setTableBets(bets.length ? bets : [Math.min(...p.allowed_wagers.map(Number))]);
  }

  // ---- the AI hosts (R3-6), served by the API ----
  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.api}${path}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BackendError(String(body.error || 'bad_args'), body.message || 'The hosts are not answering.');
    return body as T;
  }
  async agentFeed(agent: AgentId | 'all', limit = 20): Promise<AgentDecision[]> {
    return (await this.get<{ decisions: AgentDecision[] }>(`/agent/feed?agent=${agent}&limit=${limit}`)).decisions ?? [];
  }
  async agentProof(id: string): Promise<AgentProof> {
    const p = await this.get<any>(`/agent/decision/${encodeURIComponent(id)}/proof`);
    return {
      model: p.model, chatId: p.chat_id, signedText: p.signed_text, signature: p.signature, signingAddress: p.signing_address,
      signatureKind: p.signature_kind === 'gateway' ? 'gateway' : 'provider_tee', requestB64: p.request_b64, responseB64: p.response_b64,
      attestedSigner: p.attestation?.signing_address ?? '', attestationAt: p.attestation?.at ?? 0, ...(p.tx_hash ? { txHash: p.tx_hash } : {}),
    };
  }
  async activeEvents(): Promise<RealmEvent[]> {
    const now = Date.now();
    return ((await this.get<{ events: RealmEvent[] }>('/events/active')).events ?? []).filter((e) => e.endsAt > now);
  }
  houseStats() { return this.get<HouseStats>('/stats/house'); }
  churchStats() { return this.get<ChurchStats>('/stats/church'); }
  async askHost(agent: AgentId, question: string) {
    let account = '';
    try { account = (await this.session()).accountId; } catch { /* anonymous: the per-IP limit applies */ }
    const res = await fetch(`${this.api}/agent/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, question, account_id: account }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) return { answer: String(body.message || 'Enough questions for now. Come back later.'), relevant: true };
    if (!res.ok) throw new BackendError(String(body.error || 'bad_args'), body.message || 'The host did not answer.');
    return body as { answer: string; relevant: boolean; proof?: AgentProof };
  }

  private visualDecay() {
    const now = Date.now();
    const dt = Math.min((now - store.stats.settledAt) / 1000, PARAMS.maxDecayWindowS);
    store.stats.settledAt = now;
    const d = (dt / 60) * (PARAMS.decayPerMinMilli / 1000);
    if (d <= 0) return;
    if (store.realm === 'casino') store.eco.faith = Math.max(0, store.eco.faith - d);
    else if (store.realm === 'church') store.eco.luck = Math.max(0, store.eco.luck - d);
    store.saveEco(); store.emit();
  }

  private async session() { return getSession(this.api); }

  private chips(yocto: string | number): number {
    return Number(BigInt(yocto) / CHIP);
  }

  private async refresh() {
    const session = await this.session();
    dropView(this.contract, 'get_player');
    dropView(this.contract, 'get_pools');
    const player = await viewCall(this.contract, 'get_player', { account_id: session.accountId }) as PlayerView | null;
    const pools = await viewCall(this.contract, 'get_pools', {}) as { treasury: string; jackpot: string };
    const plots = await viewCall(this.contract, 'get_plots', {}) as (MachineView | null)[];
    if (player) this.writePlayer(player, pools);
    else { store.eco.chips = 0; store.eco.luck = 0; store.eco.faith = 0; }
    this.writePlots(plots ?? []);
    try {
      const balance = await accountBalance(session.accountId);
      const reserve = 5n * 10n ** 22n;
      const spendable = balance > reserve ? balance - reserve : 0n;
      store.eco.near = Number(spendable / CHIP) / 100;
    } catch { /* account may still be landing */ }
    store.stats.settledAt = Date.now();
    store.saveEco(); store.emit();
    bus.emit('plotsChanged');
  }

  private writePlayer(player: PlayerView, pools: { treasury: string; jackpot: string }) {
    store.eco.chips = this.chips(player.chips);
    store.eco.luck = player.luck_milli / 1000;
    store.eco.faith = player.faith_milli / 1000;
    const s = player.stats;
    store.stats.spins = s.spins; store.stats.flips = s.flips; store.stats.dice = s.dice;
    store.stats.roulette = s.roulette; store.stats.candles = s.candles;
    store.stats.wagered = this.chips(s.wagered); store.stats.tithed = this.chips(s.tithed);
    store.stats.converted = s.converted_milli / 1000; store.stats.faithEarned = s.faith_earned_milli / 1000;
    store.stats.candleAt = Number(BigInt(player.candle_at_ns) / 1_000_000n);
    store.stats.harmonyAt = Number(BigInt(player.harmony_at_ns) / 1_000_000n);
    store.stats.pool = this.chips(pools.treasury); store.stats.jackpot = this.chips(pools.jackpot);
    store.stats.claimed = {};
    for (let bit = 0; bit < 8; bit++) if (questBit[bit] && (player.quests_claimed & (1 << bit)) !== 0) store.stats.claimed[questBit[bit]] = true;
  }

  private writePlots(plots: (MachineView | null)[]) {
    store.plots = {};
    plots.forEach((machine, index) => {
      if (!machine) return;
      const id = index + 1;
      store.plots[id] = {
        id, owner: machine.owner, name: machine.name, skin: machine.skin,
        bankroll: this.chips(machine.bankroll), plays: machine.plays,
        earned: Number(BigInt(machine.earned_net) / CHIP), deed: machine.deed,
      };
    });
  }

  /** relay a call and wait for it. A stale delegate nonce (a fresh account, a second tab) is re-read and retried once. */
  private async relayed(method: string, args: unknown, gas: bigint): Promise<{ tx: string; done: any }> {
    for (let attempt = 0; ; attempt++) {
      const tx = await relay(this.api, this.contract, method, args, gas);
      const done = await waitTx(tx, this.relayer);
      if (txOk(done)) return { tx, done };
      const code = txPanic(done);
      const name = txFailureName(done);
      if (!code && attempt === 0 && /Nonce/i.test(name ?? '')) { await refreshNonce(); continue; }
      if (code) throw new BackendError(code, humanError(code));
      console.warn('[chain] transaction failed', method, name, done?.status);
      throw new BackendError(name ?? 'bad_args', name ? `The network refused it (${name}). Try again.` : humanError('bad_args'));
    }
  }

  private async call(method: string, args: unknown, gas = 40n * TGAS) {
    const r = await this.relayed(method, args, gas);
    await this.refresh();
    return r;
  }

  private async ensureWelcome() {
    if (this.welcomeOnce) return;
    this.welcomeOnce = true;
    const key = `cnc.welcome.v1:${(await this.session()).accountId}`;
    if (localStorage.getItem(key)) return;
    try {
      await this.call('claim_welcome', {});
      localStorage.setItem(key, '1');
    } catch (err) {
      if (err instanceof BackendError && (err.code === 'welcome_claimed' || err.code === 'vault_low')) localStorage.setItem(key, '1');
      else this.welcomeOnce = false;                     // a transient failure: try again before the next bet
    }
  }

  async placeBet(r: BetReq): Promise<BetResult> {
    const mark = timing();
    await this.ensureWelcome();
    mark('welcome');
    const session = await this.session();
    const clientSeed = crypto.getRandomValues(new Uint8Array(32));
    const { tx, done } = await this.relayed('place_bet', {
      game: r.game,
      wager: (BigInt(r.wager) * CHIP).toString(),
      pick: r.pick ?? 0,
      client_seed: bytesToHex(clientSeed),
      machine_id: r.machineId ?? 0,
    }, 50n * TGAS);
    mark('placed (relay + execution)');
    const placed = txEvents(done).find((event) => event.event === 'bet_placed')?.data;
    const betId = Number(placed?.bet_id);
    const placedHeight = Number(placed?.placed_height);
    if (!betId) throw new BackendError('bad_args', 'The bet did not land.');
    const view = await this.awaitResult(session.accountId, betId, placedHeight);
    mark('result visible');
    const result = assertOutcome(view, tx);
    result.game = r.game;
    // show the outcome now; the balance catches up a moment later (the result already carries the payout)
    store.eco.chips = Math.max(0, store.eco.chips - r.wager + result.payout);
    store.emit();
    void this.refresh().then(() => mark('refreshed')).catch(() => { /* the next action refreshes */ });
    return result;
  }

  private async awaitResult(account: string, betId: number, placedHeight: number): Promise<BetResultView> {
    this.toasted = false;
    let stop = () => {};
    let woke = false;
    stop = subscribe(this.api, account, (id) => { if (id === betId) woke = true; });
    const started = Date.now();
    let claimed = false;
    try {
      for (;;) {
        dropView(this.contract, 'get_bet_result');
        // optimistic: the result shows 2-3 blocks before it is final (the settlement itself is already executed)
        const view = await viewCall(this.contract, 'get_bet_result', { account_id: account, bet_id: betId }, 'optimistic') as BetResultView | null;
        if (view) return view;
        if (!this.toasted && Date.now() - started > 12_000) {
          this.toasted = true;
          bus.emit('toast', 'The dealer is slow. Your bet is protected.');
        }
        if (!claimed) {
          const tip = await blockTip();
          const params = await viewCall(this.contract, 'get_params', {}) as { reveal_timeout_blocks: number };
          if (tip.height >= BigInt(placedHeight) + BigInt(params.reveal_timeout_blocks ?? 60)) {
            try {
              await relay(this.api, this.contract, 'claim_timeout', { bet_id: betId }, 50n * TGAS);
              claimed = true;
            } catch (err) {
              if (err instanceof BackendError && (err.code === 'already_settled' || err.code === 'unknown_bet')) claimed = true;
              else if (!(err instanceof BackendError) || err.code !== 'too_early') throw err;
            }
          }
        }
        await new Promise((r) => setTimeout(r, woke ? 200 : 700));
        woke = false;
      }
    } finally { stop(); }
  }

  private async meterSpin(game: 'wheel' | 'harmony'): Promise<WheelResult> {
    await this.ensureWelcome();
    const session = await this.session();
    const clientSeed = crypto.getRandomValues(new Uint8Array(32));
    const { tx, done } = await this.relayed('place_bet', {
      game, wager: '0', pick: 0, client_seed: bytesToHex(clientSeed), machine_id: 0,
    }, 50n * TGAS);
    const placed = txEvents(done).find((event) => event.event === 'bet_placed')?.data;
    const view = await this.awaitResult(session.accountId, Number(placed.bet_id), Number(placed.placed_height));
    assertOutcome(view, tx);
    const prize = view.outcome.prize === 'JACKPOT' ? 'JACKPOT' as const : Number(view.outcome.prize);
    await this.refresh();
    return { prize, chips: this.chips(view.payout) };
  }

  spinWheel() { return this.meterSpin('wheel'); }
  spinHarmony() { return this.meterSpin('harmony'); }

  /** the FAITH the contract actually granted, from its event (a meter diff mixes in decay and refresh timing) */
  private faithFrom(done: any, event: string, fallback: number) {
    const ev = txEvents(done).find((e) => e.event === event)?.data;
    return ev?.faith_gain_milli !== undefined ? Number(ev.faith_gain_milli) / 1000 : fallback;
  }
  async tithe(chips: number) {
    const before = store.eco.faith;
    const { done } = await this.call('tithe', { chips });
    return { faithGain: this.faithFrom(done, 'tithe', Math.max(0, store.eco.faith - before)) };
  }
  async offerLuck(luck: number) {
    const before = store.eco.faith;
    const { done } = await this.call('offer_luck', { luck_milli: Math.round(luck * 1000) });
    return { faithGain: this.faithFrom(done, 'offering', Math.max(0, store.eco.faith - before)) };
  }
  async lightCandle() { await this.call('light_candle', {}); }
  async claimQuest(id: string) { await this.call('claim_quest', { quest_id: id }); }

  // ---- Church campaigns: rows from the contract; the server's Church oracle approves and attests ----
  async campaigns(): Promise<CampaignRow[]> {
    const session = await this.session();
    const rows = await viewCall(this.contract, 'get_campaigns', { account_id: session.accountId }, 'optimistic').catch(() => []) as {
      id: number; kind: number; creator: string; title: string; url: string; machine_id: number; goal: number; reward_chips: number;
      reward_faith_milli: number; max_claims: number; claims: number; active: boolean; claimed: boolean; progress: number;
    }[];
    return (rows ?? []).map((r) => ({
      id: r.id, kind: r.kind, creator: r.creator, title: r.title, url: r.url, machineId: r.machine_id, goal: r.goal, rewardChips: r.reward_chips,
      rewardFaith: r.reward_faith_milli / 1000, maxClaims: r.max_claims, claims: r.claims, active: r.active, claimed: r.claimed, progress: r.progress,
      mine: r.creator === session.accountId,
    }));
  }

  private async churchPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({})) as T & { error?: string; message?: string };
    if (!res.ok) throw new BackendError(out.error ?? 'bad_args', out.message ?? 'The Church could not answer. Try again.');
    return out;
  }

  async startCampaign(id: number) {
    const session = await this.session();
    const r = await this.churchPost<{ visit_s: number }>(`/campaigns/${id}/start`, { account_id: session.accountId });
    return { visitS: r.visit_s };
  }

  async claimCampaign(id: number) {
    const session = await this.session();
    const row = (await this.campaigns()).find((c) => c.id === id);
    if (!row) throw new BackendError('closed', 'That campaign has ended.');
    // machine campaigns are checked on chain; social/project ones carry the Father's 10-minute attestation
    const proof = row.kind === 2 ? { expires_ns: '0', attestation: '' }
      : await this.churchPost<{ expires_ns: string; attestation: string }>(`/campaigns/${id}/attest`, { account_id: session.accountId });
    const before = store.eco.faith;
    await this.call('claim_campaign', { id, expires_ns: proof.expires_ns, attestation: proof.attestation });
    return { chips: row.rewardChips, faith: Math.max(0, Math.round((store.eco.faith - before) * 10) / 10) || row.rewardFaith };
  }

  async createCampaign(c: NewCampaign) {
    const session = await this.session();
    const ok = await this.churchPost<{ campaign: NewCampaign; expires_ns: string; approval: string }>('/campaigns/approve', { account_id: session.accountId, campaign: c });
    const { done } = await this.relayed('create_campaign', { campaign: ok.campaign, expires_ns: ok.expires_ns, approval: ok.approval }, 60n * TGAS);
    await this.refresh();
    return Number(txEvents(done).find((e) => e.event === 'campaign_opened')?.data?.id ?? 0);
  }

  async closeCampaign(id: number) { await this.call('close_campaign', { id }); }

  async deposit(near: number) {
    const session = await this.session();
    const yocto = BigInt(Math.round(near * 100)) * CHIP;
    // a deposit is a normal signed transaction: the wallet pays the amount, the gas, and keeps the account's reserve
    const balance = await accountBalance(session.accountId).catch(() => 0n);
    const needed = yocto + 6n * 10n ** 22n;                     // + ~0.01 NEAR gas + 0.05 NEAR reserve
    if (balance < needed) {
      const have = Number(balance > 5n * 10n ** 22n ? balance - 5n * 10n ** 22n : 0n) / 1e24;
      throw new BackendError('no_near', `Your wallet has ${have.toFixed(2)} test NEAR; ${near} NEAR plus a little gas is needed. Tap GET FREE TEST NEAR first.`);
    }
    const tx = await session.signAndSend({
      receiverId: this.contract, methodName: 'deposit', args: new TextEncoder().encode('{}'), gas: 30n * TGAS, deposit: yocto,
    });
    const done = await waitTx(tx, session.accountId);
    if (!txOk(done)) throw new BackendError(txPanic(done) ?? 'bad_args', 'The deposit did not land.');
    await this.refresh();
  }

  async withdraw(chips: number) { await this.call('withdraw', { amount: (BigInt(chips) * CHIP).toString() }); }
  async faucet() {
    const session = await this.session();
    const res = await fetch(`${this.api}/faucet`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: session.accountId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new BackendError(body.error || 'bad_args', body.message || 'The faucet could not pay.');
    // the transfer lands a block or two later: wait for it so the wallet shows the new balance
    const before = store.eco.near;
    for (let i = 0; i < 12; i++) { await this.refresh(); if (store.eco.near > before) break; await new Promise((r) => setTimeout(r, 700)); }
    return Number(body.near ?? 0) || undefined;
  }
  async enterRealm(realm: 'casino' | 'church' | 'plaza') {
    store.setRealm(realm);
    await this.call('enter_realm', { realm });
  }
  async claimPlot(id: number, name: string, skin: string, bankroll: number): Promise<Plot> {
    await this.call('create_machine', { plot: id, name, skin, bankroll: (BigInt(bankroll) * CHIP).toString() }, 60n * TGAS);
    const plot = store.plots[id];
    if (!plot) throw new BackendError('bad_args', 'The plot did not appear.');
    return plot;
  }
  async fundMachine(id: number, chips: number) {
    await this.call('fund_machine', { id, amount: (BigInt(chips) * CHIP).toString() });
  }
  async withdrawMachine(id: number, chips: number) {
    await this.call('withdraw_machine', { id, amount: (BigInt(chips) * CHIP).toString() });
  }

  async wallet() {
    await this.session();
    return { accountId: wallet.accountId, encrypted: wallet.encrypted };
  }

  async checkName(name: string) {
    let account = '';
    try { account = (await this.session()).accountId; } catch { /* no account yet: any free name is fine */ }
    const res = await fetch(`${this.api}/names/check?name=${encodeURIComponent(name)}${account ? `&account=${account}` : ''}`);
    if (!res.ok) return { available: true };                 // the registry is down: never block play on it
    return await res.json() as { available: boolean; reason?: string };
  }

  /** claim the name in the server registry (signed by this account's key), then write it on chain */
  async setProfile(name: string, avatar: string) {
    const session = await this.session();
    const ts = Date.now();
    const signature = bytesToHex(ed25519.sign(new TextEncoder().encode(nameClaimMessage(session.accountId, name, ts)), session.secret));
    const res = await fetch(`${this.api}/names`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: session.accountId, name, ts, signature }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
      throw new BackendError(body.error ?? 'name', body.message ?? 'Could not save your name.');
    }
    await this.call('set_profile', { name: cleanName(name), avatar });
  }

  async completeTour(realm: 'casino' | 'church') {
    await this.call('complete_tour', { realm });
  }

  async blackjackDeal(wager: number): Promise<BjState> {
    await this.ensureWelcome();
    const session = await this.session();
    const clientSeed = crypto.getRandomValues(new Uint8Array(32));
    const { done } = await this.relayed('place_bet', {
      game: 'blackjack', wager: (BigInt(wager) * CHIP).toString(), pick: 0, client_seed: bytesToHex(clientSeed), machine_id: 0,
    }, 80n * TGAS);
    const placed = txEvents(done).find((event) => event.event === 'bet_placed')?.data;
    const betId = Number(placed?.bet_id);
    if (!betId) throw new BackendError('bad_args', 'The hand did not land.');
    return this.awaitBlackjack(session.accountId, betId, 'open');
  }

  async blackjackAct(betId: number, action: 'hit' | 'stand' | 'double'): Promise<BjState> {
    const session = await this.session();
    const before = await viewCall(this.contract, 'get_blackjack', { bet_id: betId }) as { cards_dealt?: number } | null;
    await this.call('blackjack_act', { bet_id: betId, action }, 50n * TGAS);
    return this.awaitBlackjack(session.accountId, betId, action === 'hit' ? 'card' : 'done', before?.cards_dealt ?? 0);
  }

  async history(): Promise<HistRow[]> {
    const session = await this.session();
    const res = await fetch(`${this.api}/bets?account=${encodeURIComponent(session.accountId)}&limit=40`);
    if (!res.ok) return [];
    const body = await res.json() as { bets?: { createdAt: number; game: string; wager: string; payout: string | null; detail?: string; txHash?: string | null }[] };
    return (body.bets ?? []).map((bet) => ({
      t: bet.createdAt,
      game: bet.game.toLowerCase() === 'coin' ? 'coinflip' : bet.game.toLowerCase(),
      wager: this.chips(bet.wager),
      payout: this.chips(bet.payout ?? '0'),
      detail: bet.detail || bet.game,
      ...(bet.txHash ? { tx: bet.txHash } : {}),
    }));
  }

  async leaderboard() {
    const session = await this.session();
    const res = await fetch(`${this.api}/leaderboard?by=wagered`);
    if (!res.ok) return { rows: [], demo: false as const };
    const body = await res.json() as { rows?: { rank: number; name: string; account_id: string; wagered: number; net: number }[] };
    return {
      demo: false as const,
      rows: (body.rows ?? []).map((row) => ({ ...row, you: row.account_id === session.accountId || undefined })),
    };
  }

  private async awaitBlackjack(account: string, betId: number, mode: 'open' | 'card' | 'done', dealt = 0): Promise<BjState> {
    const started = Date.now();
    for (;;) {
      dropView(this.contract, 'get_blackjack');
      dropView(this.contract, 'get_bet_result');
      const result = await viewCall(this.contract, 'get_bet_result', { account_id: account, bet_id: betId }, 'optimistic') as BetResultView | null;
      const hand = await viewCall(this.contract, 'get_blackjack', { bet_id: betId }, 'optimistic') as {
        stage: string; player: string[]; dealer: string[]; player_total: number; dealer_total: number;
        doubled: boolean; stake: string; original: string; cards_dealt: number;
      } | null;
      if (result && (mode !== 'open' || !hand)) return this.bjDone(betId, result, hand);
      if (hand && mode === 'open' && (hand.stage === 'player' || hand.stage === 'need_card')) return this.bjLive(hand, betId);
      if (hand && mode === 'card' && hand.stage === 'player' && hand.cards_dealt > dealt) return this.bjLive(hand, betId);
      if (hand && mode === 'card' && (hand.stage === 'dealer' || hand.stage === 'peek')) {
        /* the dealer still has to finish a 21 or a double; keep waiting for the result */
      }
      if (!result && Date.now() - started > 20_000) throw new BackendError('dealer_offline', 'The dealer is slow. Your bet is protected.');
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private bjLive(hand: { player: string[]; dealer: string[]; player_total: number; dealer_total: number; doubled: boolean; stake: string; original: string }, betId: number): BjState {
    const ids = hand.player.map(cardId).filter((id) => id >= 0);
    const original = this.chips(hand.original);
    return {
      betId, stage: 'player', player: hand.player, dealer: hand.dealer,
      playerTotal: hand.player_total, dealerTotal: hand.dealer_total,
      soft: handTotal(ids).soft, doubled: hand.doubled, stake: this.chips(hand.stake),
      canDouble: hand.player.length === 2 && !hand.doubled && store.eco.chips >= original,
    };
  }

  private async bjDone(betId: number, result: BetResultView, hand: { player: string[]; dealer: string[]; player_total: number; dealer_total: number } | null): Promise<BjState> {
    await this.refresh();
    const player = result.outcome.reels ?? hand?.player ?? [];
    const dealer = result.outcome.dealer_cards ?? hand?.dealer ?? [];
    const ids = player.map(cardId).filter((id) => id >= 0);
    const label = result.outcome.side;
    const mapped = label === 'natural' || label === 'win' || label === 'push' || label === 'lose' ? label : (this.chips(result.payout) > this.chips(result.wager) ? 'win' : this.chips(result.payout) === this.chips(result.wager) ? 'push' : 'lose');
    return {
      betId, stage: 'done', player, dealer,
      playerTotal: result.outcome.n ?? hand?.player_total ?? handTotal(ids).total,
      // a finished hand is cleared on chain, so count the dealer's revealed cards ourselves
      dealerTotal: hand?.dealer_total ?? handTotal(dealer.map(cardId).filter((id) => id >= 0)).total,
      soft: handTotal(ids).soft, doubled: false, stake: this.chips(result.wager), canDouble: false,
      result: { label: mapped, payout: this.chips(result.payout), blessing: this.chips(result.blessing) },
    };
  }
}

function cardId(name: string): number {
  const rank = 'A23456789TJQK'.indexOf(name[0] ?? '');
  const suit = 'CDHS'.indexOf(name[1] ?? '');
  return rank < 0 || suit < 0 ? -1 : suit * 13 + rank;
}

/** `localStorage.cncTiming = 1` logs where a bet's time goes (dev aid; silent otherwise) */
function timing() {
  let on = false;
  try { on = localStorage.getItem('cncTiming') === '1'; } catch { /* */ }
  const t0 = performance.now();
  let last = t0;
  return (label: string) => {
    if (!on) return;
    const now = performance.now();
    console.info(`[cnc-timing] ${label}: +${Math.round(now - last)} ms (total ${Math.round(now - t0)} ms)`);
    last = now;
  };
}
