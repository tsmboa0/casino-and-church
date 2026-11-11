import { TGAS, type HostId } from '@cnc/shared';
import type { Snapshot } from './observe.ts';

/**
 * Guardrails between the model and the chain (R3-4 "Validation, in order"):
 *   1. JSON parse   2. schema   3. server-side mirror of every contract bound and cooldown
 *   4. accounts must come from the observation (alms: the eligible list)   5. line filter
 * Anything that fails becomes `none` with a template line and a logged reason. The contract enforces the
 * same bounds again; this mirror only avoids sending transactions that would be refused.
 */
export interface Plan {
  action: string;
  params: Record<string, number | string>;
  line: string;
  calls: { method: string; args: unknown; gas: bigint }[];
}

export type Checked = { ok: true; plan: Plan } | { ok: false; reason: string; line?: string };

const ACTIONS: Record<HostId, string[]> = {
  fortuna: ['none', 'set_max_bet', 'set_luck_rate', 'start_happy_hour', 'end_happy_hour', 'top_up_jackpot'],
  nakamoto: ['none', 'start_vigil', 'end_vigil', 'grant_alms', 'set_blessing_cap', 'set_candle_faith'],
};

const G = 30n * TGAS;

/** The line players read. Returns a reason when it must be replaced. */
export function lineProblem(line: unknown, max = 140): string | null {
  if (typeof line !== 'string') return 'line missing';
  const t = line.trim();
  if (!t) return 'line empty';
  if (t.length > max) return 'line too long';
  if (/https?:|www\.|\.(com|io|org|net|xyz)\b/i.test(t)) return 'line has a url';
  if (/guarantee|sure win|can't lose|cannot lose|risk[- ]free|100% win/i.test(t)) return 'line promises winnings';
  if (/\b[0-9a-f]{40,}\b|\.testnet\b|\.near\b/i.test(t)) return 'line names an account';
  if (/<[a-z/]/i.test(t)) return 'line has markup';
  return null;
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const step = (cur: number, next: number) => cur > 0 && Math.abs(next - cur) * 100 <= cur * 25;

export function parseReply(content: string): { action?: unknown; params?: unknown; line?: unknown } | null {
  try {
    const j = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

export function checkDecision(agent: HostId, raw: { action?: unknown; params?: unknown; line?: unknown } | null, s: Snapshot): Checked {
  if (!raw) return { ok: false, reason: 'not json' };
  const action = typeof raw.action === 'string' ? raw.action.trim() : '';
  if (!ACTIONS[agent].includes(action)) return { ok: false, reason: `action "${action.slice(0, 40)}" is not one of my tools` };
  const p = (raw.params && typeof raw.params === 'object' ? raw.params : {}) as Record<string, unknown>;
  const bad = lineProblem(raw.line);
  if (bad) return { ok: false, reason: bad };
  const line = String(raw.line).trim();
  const plan = (params: Plan['params'], calls: Plan['calls']): Checked => ({ ok: true, plan: { action, params, line, calls } });
  const event = (realm: 'casino' | 'church') => s.active_events.find((e) => e.realm === realm);
  const cooldownMin = (realm: 'casino' | 'church') => s.minutes_since_event_start[realm];

  switch (action) {
    case 'none':
      return plan({}, []);
    case 'set_max_bet': {
      const v = int(p.value);
      if (v === null) return { ok: false, reason: 'value is not a whole number' };
      const lo = Math.max(10, Math.max(...s.params.allowed_wagers));
      if (v < lo || v > 500) return { ok: false, reason: `max bet ${v} outside [${lo}, 500]` };
      if (v === s.params.max_bet) return { ok: false, reason: 'max bet unchanged' };
      if (!step(s.params.max_bet, v)) return { ok: false, reason: 'more than a 25% step' };
      if (s.minutes_since_param_change < 5) return { ok: false, reason: 'param cooldown (5 min)' };
      return plan({ value: v }, [{ method: 'set_params', args: { patch: { max_bet_chips: v } }, gas: G }]);
    }
    case 'set_luck_rate': {
      const v = int(p.value);
      if (v === null || v < 20 || v > 120) return { ok: false, reason: 'luck rate outside [20, 120]' };
      if (v === s.params.luck_per_chip_milli) return { ok: false, reason: 'luck rate unchanged' };
      if (!step(s.params.luck_per_chip_milli, v)) return { ok: false, reason: 'more than a 25% step' };
      if (s.minutes_since_param_change < 5) return { ok: false, reason: 'param cooldown (5 min)' };
      return plan({ value: v }, [{ method: 'set_params', args: { patch: { luck_per_chip_milli: v } }, gas: G }]);
    }
    case 'start_happy_hour':
    case 'start_vigil': {
      const realm = action === 'start_happy_hour' ? 'casino' : 'church';
      const minutes = int(p.minutes), pct = int(p.boost_pct);
      if (minutes === null || minutes < 10 || minutes > 60) return { ok: false, reason: 'minutes outside [10, 60]' };
      if (pct === null || pct < 10 || pct > 50) return { ok: false, reason: 'boost outside [10, 50]%' };
      if (event(realm)) return { ok: false, reason: 'an event is already running' };
      if (s.events_today[realm] >= 4) return { ok: false, reason: 'four events today already' };
      if (cooldownMin(realm) < 90) return { ok: false, reason: '90 minutes between events' };
      const kind = realm === 'casino' ? 'happy_hour' : 'vigil';
      return plan({ minutes, boost_pct: pct }, [{ method: 'start_event', args: { kind, minutes, boost_bps: pct * 100 }, gas: G }]);
    }
    case 'end_happy_hour':
    case 'end_vigil': {
      const realm = action === 'end_happy_hour' ? 'casino' : 'church';
      if (!event(realm)) return { ok: false, reason: 'no event to end' };
      return plan({}, [{ method: 'end_event', args: { kind: realm === 'casino' ? 'happy_hour' : 'vigil' }, gas: G }]);
    }
    case 'top_up_jackpot': {
      const chips = int(p.chips);
      if (chips === null || chips < 1 || chips > 500) return { ok: false, reason: 'chips outside [1, 500]' };
      if (chips > s.jackpot_topup_max_now) return { ok: false, reason: `vault health allows at most ${s.jackpot_topup_max_now} now` };
      return plan({ chips }, [{ method: 'top_up_jackpot', args: { chips }, gas: G }]);
    }
    case 'grant_alms': {
      const alias = String(p.account ?? '');
      const who = s.eligible_for_alms.find((e) => e.alias === alias);
      if (!who) return { ok: false, reason: 'alms only to an eligible player from the list' };
      const chips = int(p.chips);
      if (chips === null || chips < 1 || chips > 50) return { ok: false, reason: 'alms outside [1, 50]' };
      if (chips > s.alms_budget_today) return { ok: false, reason: `alms budget left today is ${s.alms_budget_today}` };
      return plan({ chips, account: alias }, [{ method: 'grant_alms', args: { player: s.alias_to_account[alias], chips }, gas: G }]);
    }
    case 'set_blessing_cap': {
      const v = int(p.bps);
      if (v === null || v < 100 || v > 1000) return { ok: false, reason: 'blessing cap outside [100, 1000] bps' };
      if (v === s.params.blessing_cap_bps) return { ok: false, reason: 'blessing cap unchanged' };
      if (!step(s.params.blessing_cap_bps, v)) return { ok: false, reason: 'more than a 25% step' };
      if (s.minutes_since_church_change < 30) return { ok: false, reason: 'church cooldown (30 min)' };
      return plan({ bps: v }, [{ method: 'set_church_params', args: { patch: { blessing_day_cap_bps: v } }, gas: G }]);
    }
    case 'set_candle_faith': {
      const v = int(p.milli);
      if (v === null || v < 2000 || v > 4000) return { ok: false, reason: 'candle faith outside [2000, 4000]' };
      if (v === s.params.candle_faith_milli) return { ok: false, reason: 'candle faith unchanged' };
      if (!step(s.params.candle_faith_milli, v)) return { ok: false, reason: 'more than a 25% step' };
      if (s.minutes_since_church_change < 30) return { ok: false, reason: 'church cooldown (30 min)' };
      return plan({ milli: v }, [{ method: 'set_church_params', args: { patch: { candle_faith_milli: v } }, gas: G }]);
    }
  }
  return { ok: false, reason: 'unknown action' };
}
