import type { AccountRow, AttestationRow, BetRow, HostDecisionRow, PlayerRow, SeedRow, Store } from './store.ts';

export class MemoryStore implements Store {
  accounts = new Map<string, AccountRow>();
  quotas = new Map<string, { count: number; gasTgas: number }>();
  deniedKeys = new Set<string>();
  seeds = new Map<number, SeedRow>();
  bets = new Map<number, BetRow>();
  players = new Map<string, PlayerRow>();
  faucets: { accountId: string; ip: string; at: number }[] = [];
  feed: HostDecisionRow[] = [];
  attestations: AttestationRow[] = [];
  locked = false;

  async account(id: string) { return this.accounts.get(id) ?? null; }
  private names = new Map<string, { accountId: string; name: string }>();
  async nameOwner(key: string) { return this.names.get(key) ?? null; }
  async nameOf(accountId: string) { for (const v of this.names.values()) if (v.accountId === accountId) return v.name; return null; }
  async claimName(accountId: string, key: string, name: string) {
    const held = this.names.get(key);
    if (held && held.accountId !== accountId) return false;
    for (const [k, v] of this.names) if (v.accountId === accountId) this.names.delete(k);
    this.names.set(key, { accountId, name });
    return true;
  }
  async insertAccount(row: AccountRow) {
    if (this.accounts.has(row.accountId)) return false;
    this.accounts.set(row.accountId, row);
    return true;
  }
  async countAccounts() { return this.accounts.size; }
  async accountsByIpSince(ip: string, sinceMs: number) {
    let n = 0;
    for (const row of this.accounts.values()) if (row.ip === ip && row.createdAt >= sinceMs) n++;
    return n;
  }
  private qk(scope: string, id: string, bucket: string) { return `${scope}\0${id}\0${bucket}`; }
  async quota(scope: string, id: string, bucket: string) {
    return this.quotas.get(this.qk(scope, id, bucket)) ?? { count: 0, gasTgas: 0 };
  }
  async addQuota(scope: string, id: string, bucket: string, count: number, gasTgas: number) {
    const key = this.qk(scope, id, bucket);
    const cur = this.quotas.get(key) ?? { count: 0, gasTgas: 0 };
    this.quotas.set(key, { count: cur.count + count, gasTgas: cur.gasTgas + gasTgas });
  }
  async setQuota(scope: string, id: string, bucket: string, count: number, gasTgas: number) {
    this.quotas.set(this.qk(scope, id, bucket), { count, gasTgas });
  }
  async denied(kind: string, value: string) { return this.deniedKeys.has(`${kind}\0${value}`); }
  async putSeed(row: SeedRow) { this.seeds.set(row.idx, row); }
  async seed(idx: number) { return this.seeds.get(idx) ?? null; }
  async seedsByStatus(status: string) { return [...this.seeds.values()].filter((s) => s.status === status).sort((a, b) => a.idx - b.idx); }
  async markSeed(idx: number, status: string) {
    const row = this.seeds.get(idx);
    if (row) row.status = status;
  }
  async recordBet(row: BetRow) { this.bets.set(row.betId, row); }
  async blessingsSince(sinceMs: number) { let t = 0n; for (const b of this.bets.values()) if (b.createdAt >= sinceMs && b.blessing) t += BigInt(b.blessing); return t; }
  async bet(id: number) { return this.bets.get(id) ?? null; }
  async recentBets(accountId: string, limit: number) {
    return [...this.bets.values()].filter((b) => b.accountId === accountId).sort((a, b) => b.betId - a.betId).slice(0, limit);
  }
  async upsertPlayer(row: PlayerRow) { this.players.set(row.accountId, row); }
  async player(accountId: string) { return this.players.get(accountId) ?? null; }
  async leaderboard(by: 'wagered' | 'faith' | 'net', limit: number) {
    const rows = [...this.players.values()];
    const key = (p: PlayerRow) => by === 'faith' ? p.faithMilli : by === 'net' ? BigInt(p.net) : BigInt(p.wagered);
    rows.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
    return rows.slice(0, limit);
  }
  async countPlayers() { return this.players.size; }
  async volumeYocto() {
    let n = 0n;
    for (const b of this.bets.values()) n += BigInt(b.wager);
    return n.toString();
  }
  async timeoutCount() {
    let n = 0;
    for (const b of this.bets.values()) if (b.via === 'timeout') n++;
    return n;
  }
  async faucetSince(accountId: string, sinceMs: number) {
    return this.faucets.filter((f) => f.accountId === accountId && f.at >= sinceMs).length;
  }
  async faucetIpSince(ip: string, sinceMs: number) {
    return this.faucets.filter((f) => f.ip === ip && f.at >= sinceMs).length;
  }
  async recordFaucet(accountId: string, ip: string, at: number) { this.faucets.push({ accountId, ip, at }); }
  async addHostDecision(row: HostDecisionRow) {
    this.feed.unshift(row);
    this.feed = this.feed.slice(0, 500);
  }
  async hostDecisions(agent: 'fortuna' | 'nakamoto' | 'all', limit: number) {
    return this.feed.filter((d) => agent === 'all' || d.agent === agent).slice(0, limit);
  }
  async hostDecision(id: string) { return this.feed.find((d) => d.id === id) ?? null; }
  async addAttestation(row: Omit<AttestationRow, 'id'>) {
    const full = { ...row, id: this.attestations.length + 1 };
    this.attestations.unshift(full);
    this.attestations = this.attestations.slice(0, 50);
    return full;
  }
  async attestation(id: number) { return this.attestations.find((a) => a.id === id) ?? null; }
  async latestAttestation(model: string) { return this.attestations.find((a) => a.model === model) ?? null; }
  async biggestWin(sinceMs: number) {
    let best: BetRow | null = null;
    for (const b of this.bets.values()) {
      if (b.createdAt < sinceMs || !b.payout) continue;
      if (BigInt(b.payout) <= BigInt(b.wager)) continue;
      if (!best || BigInt(b.payout) > BigInt(best.payout!)) best = b;
    }
    return best ? { accountId: best.accountId, game: best.game, payout: best.payout! } : null;
  }
  async dayStats(sinceMs: number) {
    let bets = 0, timeouts = 0, volume = 0n, house = 0n, settle = 0, timed = 0;
    for (const bet of this.bets.values()) {
      if (bet.createdAt < sinceMs) continue;
      bets++;
      const wager = BigInt(bet.wager);
      const payout = BigInt(bet.payout ?? '0');
      volume += wager;
      house += wager - payout;
      if (bet.via === 'timeout') timeouts++;
      if (bet.settleMs) { settle += bet.settleMs; timed++; }
    }
    return { bets, volume: volume.toString(), houseNet: house.toString(), timeouts, avgSettleMs: timed ? Math.round(settle / timed) : 0 };
  }
  async tryDealerLock() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
}
