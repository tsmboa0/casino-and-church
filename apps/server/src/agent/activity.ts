/**
 * What the hosts can see of the floor, without a block indexer: every player call already passes through our
 * relayer, so it records (account, method, realm, chips) as calls are broadcast. In memory, last 24 h only;
 * it is observation for the hosts and the screens, never an input to settlement.
 */
type Realm = 'casino' | 'church' | 'plaza';

interface Seen { at: number; realm: Realm }
interface Mark { at: number; account: string; method: string; chips: number }

const DAY = 86_400_000;
const ONLINE_MS = 15 * 60_000;

const CASINO_METHODS = new Set(['place_bet', 'blackjack_act', 'claim_timeout', 'market_bet']);
const CHURCH_METHODS = new Set(['tithe', 'light_candle', 'offer_luck', 'claim_quest']);

export class Activity {
  private seen = new Map<string, Seen>();
  private marks: Mark[] = [];
  private presenceLog: { at: number; casino: number; church: number }[] = [];

  record(account: string, method: string, args: unknown, at = Date.now()) {
    const a = (args ?? {}) as Record<string, unknown>;
    const prev = this.seen.get(account);
    let realm: Realm = prev?.realm ?? 'plaza';
    if (method === 'enter_realm') {
      const r = String(a.realm ?? '');
      realm = r === 'casino' || r === 'church' ? r : 'plaza';
    } else if (CASINO_METHODS.has(method)) realm = 'casino';
    else if (CHURCH_METHODS.has(method)) realm = 'church';
    this.seen.set(account, { at, realm });
    let chips = 0;
    if (method === 'tithe') chips = Number(a.chips ?? 0) || 0;
    this.marks.push({ at, account, method, chips });
    this.prune(at);
  }

  private prune(now: number) {
    if (this.marks.length && this.marks[0]!.at < now - DAY) this.marks = this.marks.filter((m) => m.at >= now - DAY);
    if (this.presenceLog.length > 400) this.presenceLog = this.presenceLog.slice(-300);
  }

  presence(now = Date.now()) {
    let casino = 0, church = 0, plaza = 0;
    for (const s of this.seen.values()) {
      if (now - s.at > ONLINE_MS) continue;
      if (s.realm === 'casino') casino++;
      else if (s.realm === 'church') church++;
      else plaza++;
    }
    return { online: casino + church + plaza, casino, church, plaza };
  }

  /** sample presence once a minute so triggers can ask "for how long has the church out-drawn the casino?" */
  sample(now = Date.now()) {
    const p = this.presence(now);
    this.presenceLog.push({ at: now, casino: p.casino, church: p.church });
    this.prune(now);
  }

  /** true when `a` has held more than ratio x `b`'s players for the whole window (and at least one player) */
  dominated(a: 'casino' | 'church', windowMs: number, ratio = 2, now = Date.now()): boolean {
    const rows = this.presenceLog.filter((r) => r.at >= now - windowMs);
    if (rows.length < Math.max(3, windowMs / 120_000)) return false;
    const b = a === 'casino' ? 'church' : 'casino';
    return rows.every((r) => r[a] > 0 && r[a] > ratio * r[b]);
  }

  count(method: string, sinceMs: number) { return this.marks.filter((m) => m.method === method && m.at >= sinceMs).length; }
  sum(method: string, sinceMs: number) { return this.marks.filter((m) => m.method === method && m.at >= sinceMs).reduce((n, m) => n + m.chips, 0); }

  /** accounts active in the last 24 h, most recent first (alms candidates are checked on chain) */
  recentAccounts(limit = 40, now = Date.now()): string[] {
    return [...this.seen.entries()].filter(([, s]) => now - s.at < DAY).sort((x, y) => y[1].at - x[1].at).slice(0, limit).map(([id]) => id);
  }
}
