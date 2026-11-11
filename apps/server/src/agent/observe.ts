import type { HostId } from '@cnc/shared';
import type { Store, HostDecisionRow } from '../db/store.ts';
import type { NearRpc } from '../near/rpc.ts';
import type { Activity } from './activity.ts';

/**
 * The observation a host decides on. Under ~600 tokens as JSON. Amounts are whole chips.
 * Accounts never appear: alms candidates get aliases (p1, p2...), mapped back only when acting.
 */
export interface Snapshot {
  at: number;
  vault: number; vault_free: number; reserved: number; treasury: number; jackpot: number;
  players_online: number; in_casino: number; in_church: number; in_plaza: number;
  volume_1h: number; volume_24h: number; house_net_1h: number; house_net_24h: number; timeouts_24h: number;
  biggest_win_24h: { chips: number; game: string } | null;
  tithes_24h: number; candles_24h: number; alms_24h: number;
  params: { max_bet: number; luck_per_chip_milli: number; blessing_cap_bps: number; candle_faith_milli: number; allowed_wagers: number[] };
  active_events: { kind: string; realm: 'casino' | 'church'; minutes_left: number; boost_pct: number; by: string }[];
  events_today: { casino: number; church: number };
  minutes_since_event_start: { casino: number; church: number };
  minutes_since_param_change: number;
  minutes_since_church_change: number;
  jackpot_topup_max_now: number;
  alms_budget_today: number;
  eligible_for_alms: { alias: string; chips: number }[];
  alias_to_account: Record<string, string>;
  rival_last_3: { action: string; line: string; minutes_ago: number }[];
  your_last_3: { action: string; line: string; applied: boolean; minutes_ago: number }[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

export async function observe(deps: { rpc: NearRpc; store: Store; activity: Activity }, agent: HostId, now = Date.now()): Promise<Snapshot> {
  const { rpc, store, activity } = deps;
  const [pools, params, events, day, hour, best, history] = await Promise.all([
    rpc.view('get_pools', {}),
    rpc.view('get_params', {}),
    rpc.view('get_events', {}).catch(() => []),
    store.dayStats(now - DAY),
    store.dayStats(now - HOUR),
    store.biggestWin(now - DAY),
    store.hostDecisions('all', 60),
  ]);
  const chip = BigInt(params.chip_yocto);
  const c = (v: unknown) => Number(BigInt(String(v ?? '0').split('.')[0] || '0') / chip);
  const vault = c(pools.vault), reserved = c(pools.reserved), vaultFree = c(pools.vault_free), treasury = c(pools.treasury);
  const presence = activity.presence(now);

  const applied = history.filter((d) => d.applied);
  const since = (pred: (d: HostDecisionRow) => boolean) => {
    const last = applied.find(pred);
    return last ? Math.floor((now - last.at) / 60_000) : 9_999;
  };
  const utcDay = Math.floor(now / DAY);
  const today = (action: string) => applied.filter((d) => d.action === action && Math.floor(d.at / DAY) === utcDay).length;
  const almsToday = applied.filter((d) => d.action === 'grant_alms' && Math.floor(d.at / DAY) === utcDay).reduce((n, d) => n + Number(d.params.chips ?? 0), 0);
  const topupToday = applied.filter((d) => d.action === 'top_up_jackpot' && Math.floor(d.at / DAY) === utcDay).reduce((n, d) => n + Number(d.params.chips ?? 0), 0);

  // alms candidates: recently active players who ran dry, checked against the contract's own eligibility rule
  const eligible: { alias: string; chips: number }[] = [];
  const aliasMap: Record<string, string> = {};
  if (agent === 'nakamoto') {
    const recentAlms = new Set(applied.filter((d) => d.action === 'grant_alms' && now - d.at < DAY).map((d) => String(d.params.player ?? '')));
    for (const account of activity.recentAccounts(25, now)) {
      if (eligible.length >= 5 || recentAlms.has(account)) continue;
      const p = await rpc.view('get_player', { account_id: account }).catch(() => null);
      if (!p) continue;
      const chips = c(p.chips);
      const active = c(p.stats?.wagered) >= 100 || Number(p.stats?.candles ?? 0) >= 1;
      if (chips < 50 && active) {
        const alias = `p${eligible.length + 1}`;
        eligible.push({ alias, chips });
        aliasMap[alias] = account;
      }
    }
  }

  const rival: HostId = agent === 'fortuna' ? 'nakamoto' : 'fortuna';
  const ago = (t: number) => Math.floor((now - t) / 60_000);
  const evs = (events as any[]).map((e) => ({
    kind: String(e.kind),
    realm: (e.realm === 'church' ? 'church' : 'casino') as 'casino' | 'church',
    minutes_left: Math.max(0, Math.ceil((Number(BigInt(e.ends_ns) / 1_000_000n) - now) / 60_000)),
    boost_pct: Math.round(Number(e.boost_bps) / 100),
    by: e.realm === 'church' ? 'nakamoto' : 'fortuna',
  }));

  return {
    at: now,
    vault, vault_free: vaultFree, reserved, treasury, jackpot: c(pools.jackpot),
    players_online: presence.online, in_casino: presence.casino, in_church: presence.church, in_plaza: presence.plaza,
    volume_1h: c(hour.volume), volume_24h: c(day.volume), house_net_1h: c(hour.houseNet), house_net_24h: c(day.houseNet), timeouts_24h: day.timeouts,
    biggest_win_24h: best ? { chips: c(best.payout), game: best.game } : null,
    tithes_24h: activity.sum('tithe', now - DAY), candles_24h: activity.count('light_candle', now - DAY), alms_24h: almsToday,
    params: {
      max_bet: Number(params.max_bet_chips), luck_per_chip_milli: Number(params.luck_per_chip_milli),
      blessing_cap_bps: Number(params.blessing_day_cap_bps), candle_faith_milli: Number(params.candle_faith_milli),
      allowed_wagers: (params.allowed_wagers as number[]).map(Number),
    },
    active_events: evs,
    events_today: { casino: today('start_happy_hour'), church: today('start_vigil') },
    minutes_since_event_start: { casino: since((d) => d.action === 'start_happy_hour'), church: since((d) => d.action === 'start_vigil') },
    minutes_since_param_change: since((d) => d.action === 'set_max_bet' || d.action === 'set_luck_rate'),
    minutes_since_church_change: since((d) => d.action === 'set_blessing_cap' || d.action === 'set_candle_faith'),
    // contract: vault_free >= 3 x (reserved + chips), at most 500 per call and 2 000 per day
    jackpot_topup_max_now: Math.max(0, Math.min(500, 2_000 - topupToday, Math.floor(vaultFree / 3) - reserved)),
    // contract: 2% of the treasury at the start of the UTC day (approximated with the current treasury)
    alms_budget_today: Math.max(0, Math.floor(treasury * 0.02) - almsToday),
    eligible_for_alms: eligible,
    alias_to_account: aliasMap,
    rival_last_3: history.filter((d) => d.agent === rival).slice(0, 3).map((d) => ({ action: d.action, line: d.line, minutes_ago: ago(d.at) })),
    your_last_3: history.filter((d) => d.agent === agent).slice(0, 3).map((d) => ({ action: d.action, line: d.line, applied: d.applied, minutes_ago: ago(d.at) })),
  };
}

/** What the model sees: the snapshot without the alias map (accounts never go to the model). */
export function forModel(s: Snapshot, agent: HostId) {
  const { alias_to_account: _a, at: _t, eligible_for_alms, alms_budget_today, jackpot_topup_max_now, minutes_since_church_change, minutes_since_param_change, ...rest } = s;
  return agent === 'fortuna'
    ? { ...rest, jackpot_topup_max_now, minutes_since_param_change }
    : { ...rest, eligible_for_alms, alms_budget_today, minutes_since_church_change };
}
