import type { HostId } from '@cnc/shared';
import type { Config } from '../config.ts';
import type { AttestationRow, HostDecisionRow, Store } from '../db/store.ts';
import type { Hub } from '../indexer/hub.ts';
import type { KeyPool } from '../near/pool.ts';
import type { NearRpc } from '../near/rpc.ts';
import type { Activity } from './activity.ts';
import { askHost, type AskResult } from './ask.ts';
import { Host } from './host.ts';
import { NearAI, TokenBudget } from './nearai.ts';
import { forModel, observe } from './observe.ts';

/** Client shapes (apps/client/src/core/backend.ts, R3-6). */
export interface AgentDecisionDTO {
  id: string; agent: HostId; at: number; action: string; params: Record<string, number | string>; line: string;
  applied: boolean; reason?: string; txHash?: string; policy: 'llm' | 'rules';
  proof?: {
    model: string; chatId: string; signedText: string; signature: string; signingAddress: string; signatureKind: 'provider_tee' | 'gateway';
    requestB64: string; responseB64: string; attestedSigner: string; attestationAt: number; txHash?: string;
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const ATTEST_EVERY = HOUR;
const TRIGGER_GAP = 3 * MIN;

/**
 * Don Fortuna and Father Nakamoto. Schedule (R3-4): every `agentEveryMin` (10) minutes with ±60 s jitter, the
 * Father offset by 5 minutes; plus event triggers checked every minute, at least 3 minutes apart per host.
 */
export class Hosts {
  readonly ai: NearAI | null;
  readonly budget: TokenBudget;
  readonly hosts: Record<HostId, Host>;
  private timers: NodeJS.Timeout[] = [];
  private next: Record<HostId, number> = { fortuna: 0, nakamoto: 0 };
  private attesting: Promise<AttestationRow | null> | null = null;
  private samples: { at: number; vault: number; treasury: number }[] = [];
  private lastWinCheck = Date.now();
  private stateCache = new Map<HostId, { at: number; body: unknown }>();
  /** attestation rows never change: one database read per id, ever */
  private attCache = new Map<number, AttestationRow | null>();
  private async att(id: number | null) {
    if (!id) return null;
    if (!this.attCache.has(id)) this.attCache.set(id, await this.store.attestation(id));
    return this.attCache.get(id) ?? null;
  }
  running = false;

  constructor(
    private config: Config,
    private rpc: NearRpc,
    private store: Store,
    private hub: Hub,
    private activity: Activity,
    pools: { fortuna: KeyPool | null; nakamoto: KeyPool | null },
  ) {
    this.ai = config.nearaiKey ? new NearAI(config.nearaiBase, config.nearaiKey, config.nearaiModel) : null;
    this.budget = new TokenBudget(config.nearaiDailyTokens, config.chatTokenShare);
    const deps = (pool: KeyPool | null) => ({
      rpc, store, activity, ai: this.ai, budget: this.budget, pool,
      attestation: () => this.attestation(),
      publish: (row: HostDecisionRow, eventsChanged: boolean) => this.publish(row, eventsChanged),
    });
    this.hosts = { fortuna: new Host('fortuna', deps(pools.fortuna)), nakamoto: new Host('nakamoto', deps(pools.nakamoto)) };
  }

  start() {
    if (this.running || this.config.agentsDisabled) return;
    this.running = true;
    const now = Date.now();
    this.next.fortuna = now + 30_000;                         // first decision shortly after boot
    this.next.nakamoto = now + 30_000 + 5 * MIN;
    this.timers.push(setInterval(() => { void this.tick(); }, 20_000));
    this.timers.push(setInterval(() => this.activity.sample(), MIN));
    void this.attestation();
  }

  stop() { this.running = false; this.timers.forEach(clearInterval); this.timers = []; }

  private every() { return Math.max(1, this.config.agentEveryMin) * MIN; }
  private jitter() { return Math.round((Math.random() * 2 - 1) * MIN); }

  private async tick() {
    const now = Date.now();
    for (const agent of ['fortuna', 'nakamoto'] as HostId[]) {
      if (now >= this.next[agent]) {
        this.next[agent] = now + this.every() + this.jitter();
        void this.hosts[agent].cycle('schedule');
      }
    }
    try { await this.checkTriggers(now); } catch { /* observation only */ }
  }

  /** extra cycles when something happens on the floor (R3-4 "Event triggers") */
  private async checkTriggers(now: number) {
    const pools = await this.rpc.view('get_pools', {});
    const params = await this.rpc.view('get_params', {});
    const chip = BigInt(params.chip_yocto);
    const vault = Number(BigInt(pools.vault) / chip), treasury = Number(BigInt(pools.treasury) / chip);
    this.samples.push({ at: now, vault, treasury });
    this.samples = this.samples.filter((s) => s.at >= now - 24 * HOUR);
    const hourAgo = this.samples.find((s) => s.at >= now - HOUR);
    const dayAgo = this.samples[0];
    const fire = (agent: HostId, why: string) => {
      const h = this.hosts[agent];
      if (now - h.lastCycleAt < TRIGGER_GAP) return;
      void h.cycle(why);
    };
    const win = await this.store.biggestWin(this.lastWinCheck);
    this.lastWinCheck = now;
    if (win && BigInt(win.payout) / chip >= 1_000n) fire('fortuna', 'a single win of 1000+ chips');
    if (hourAgo && hourAgo.vault > 0 && vault < hourAgo.vault * 0.9) fire('fortuna', 'the vault fell 10% in an hour');
    if (this.activity.dominated('church', 15 * MIN)) fire('fortuna', 'the church has held 2x the casino for 15 minutes');
    if (dayAgo && dayAgo.treasury > 0 && treasury > dayAgo.treasury * 1.2 && now - dayAgo.at > 6 * HOUR) fire('nakamoto', 'the treasury grew 20% today');
    const p = this.activity.presence(now);
    if (p.church > 0 && this.activity.count('light_candle', now - HOUR) === 0 && now - this.hosts.nakamoto.lastCycleAt > HOUR) fire('nakamoto', 'no candles lit in the last hour');
    if (this.activity.dominated('casino', 15 * MIN)) fire('nakamoto', 'the casino has held 2x the church for 15 minutes');
  }

  /** the attested enclave key, refreshed hourly with our own nonce */
  async attestation(): Promise<AttestationRow | null> {
    if (!this.ai) return null;
    const last = await this.store.latestAttestation(this.ai.model);
    if (last && Date.now() - last.at < ATTEST_EVERY) return last;
    if (!this.attesting) {
      this.attesting = this.ai.attest()
        .then((a) => this.store.addAttestation(a))
        .catch((err) => { console.error(JSON.stringify({ at: 'attest', error: err instanceof Error ? err.message : String(err) })); return last; })
        .finally(() => { this.attesting = null; });
    }
    return this.attesting;
  }

  private publish(row: HostDecisionRow, eventsChanged: boolean) {
    void this.toDTO(row).then((dto) => {
      this.hub.broadcast('agent_decision', dto);
      if (eventsChanged) this.hub.broadcast('events_changed', { at: Date.now() });
    });
  }

  async toDTO(row: HostDecisionRow): Promise<AgentDecisionDTO> {
    const { player: _private, ...params } = row.params;
    const dto: AgentDecisionDTO = {
      id: row.id, agent: row.agent, at: row.at, action: row.action, params, line: row.line, applied: row.applied, policy: row.policy,
      ...(row.reason ? { reason: row.reason } : {}), ...(row.txHash ? { txHash: row.txHash } : {}),
    };
    if (row.policy === 'llm' && row.signature && row.signedText && row.requestB64 && row.responseB64 && row.signingAddress) {
      const att = await this.att(row.attestationId);
      dto.proof = {
        model: row.model ?? '', chatId: row.chatId ?? '', signedText: row.signedText, signature: row.signature, signingAddress: row.signingAddress,
        signatureKind: row.signatureKind === 'gateway' ? 'gateway' : 'provider_tee', requestB64: row.requestB64, responseB64: row.responseB64,
        attestedSigner: att?.signingAddress ?? '', attestationAt: att?.at ?? 0, ...(row.txHash && row.applied ? { txHash: row.txHash } : {}),
      };
    }
    return dto;
  }

  async feed(agent: HostId | 'all', limit: number): Promise<AgentDecisionDTO[]> {
    const rows = await this.store.hostDecisions(agent, Math.min(40, Math.max(1, limit)));
    return Promise.all(rows.map((r) => this.toDTO(r)));
  }

  async proof(id: string) {
    const row = await this.store.hostDecision(id);
    if (!row) return null;
    const att = await this.att(row.attestationId);
    return {
      model: row.model, chat_id: row.chatId, request_b64: row.requestB64, response_b64: row.responseB64, signed_text: row.signedText,
      signature: row.signature, signing_address: row.signingAddress, signature_kind: row.signatureKind,
      attestation: att ? { id: att.id, at: att.at, nonce: att.nonce, signing_address: att.signingAddress, intel_quote_bytes: att.intelQuoteBytes, has_gpu_evidence: att.hasGpuEvidence } : null,
      tx_hash: row.applied ? row.txHash : null, applied: row.applied, reason: row.reason, policy: row.policy,
    };
  }

  /** a compact, true picture for the chat persona ("what are you up to?"); cached for a minute */
  private async chatState(agent: HostId) {
    const hit = this.stateCache.get(agent);
    if (hit && Date.now() - hit.at < MIN) return hit.body;
    const snap = this.hosts[agent].lastSnapshot && Date.now() - this.hosts[agent].lastSnapshot!.at < 15 * MIN
      ? this.hosts[agent].lastSnapshot!
      : await observe({ rpc: this.rpc, store: this.store, activity: this.activity }, agent);
    const m = forModel(snap, agent) as Record<string, unknown>;
    delete m.eligible_for_alms;
    const body = { ...m, your_last_3: snap.your_last_3 };
    this.stateCache.set(agent, { at: Date.now(), body });
    return body;
  }

  ask(agent: HostId, question: string, account: string, ip: string): Promise<AskResult> {
    return askHost({
      agent, question, account, ip, store: this.store, ai: this.ai, budget: this.budget,
      perAccountHour: this.config.askPerAccountHour, perIpHour: this.config.askPerIpHour,
      state: () => this.chatState(agent), attestation: () => this.attestation(),
    });
  }

  status() {
    return {
      running: this.running,
      model: this.ai?.model ?? null,
      tokens: this.budget.snapshot,
      fortuna: { last: this.hosts.fortuna.lastCycleAt, next: this.next.fortuna, error: this.hosts.fortuna.lastError },
      nakamoto: { last: this.hosts.nakamoto.lastCycleAt, next: this.next.nakamoto, error: this.hosts.nakamoto.lastError },
    };
  }
}
