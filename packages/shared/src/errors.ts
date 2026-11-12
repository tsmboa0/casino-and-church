/** Contract panic strings. The client maps these; the server returns the same codes. */
export const PANIC_CODES = [
  'paused', 'not_allowed', 'bad_wager', 'bad_pick', 'no_chips', 'max_bet', 'vault_low',
  'dealer_offline', 'unknown_bet', 'bad_seed', 'too_early', 'already_settled', 'luck_low',
  'faith_low', 'cooldown', 'welcome_claimed', 'plot_taken', 'plot_gate', 'bad_name',
  'bankroll_low', 'reserve', 'not_owner', 'rate_limited', 'bad_args',
  'too_late', 'bad_signature', 'already_claimed', 'not_done', 'closed', 'treasury_low',
] as const;

export type PanicCode = (typeof PANIC_CODES)[number];

export const RELAY_ALLOWLIST = [
  'place_bet', 'claim_timeout', 'withdraw', 'claim_welcome', 'set_profile', 'enter_realm',
  'complete_tour', 'tithe', 'offer_luck', 'light_candle', 'claim_quest', 'create_machine',
  'fund_machine', 'withdraw_machine', 'blackjack_act',
  'create_campaign', 'claim_campaign', 'close_campaign',
  'market_bet', 'market_settle',
] as const;

export const ERROR_TEXT: Record<string, string> = {
  paused: 'The casino is paused. Withdrawals still work.',
  too_late: 'That approval expired. Try again.',
  bad_signature: 'The Church could not confirm that. Try again.',
  already_claimed: 'You already claimed this one.',
  not_done: 'Finish the task first.',
  closed: 'That campaign has ended.',
  treasury_low: 'The treasury cannot cover that right now.',
  not_allowed: 'That action is not allowed.',
  bad_wager: 'Pick one of the listed bets.',
  bad_pick: 'That pick is not valid.',
  no_chips: 'Not enough chips. Visit the Cashier.',
  max_bet: 'That bet is above the table limit.',
  vault_low: 'The house cannot cover that bet right now.',
  dealer_offline: 'The dealer is offline. Try again in a moment.',
  unknown_bet: 'That bet is already settled.',
  bad_seed: 'The dealer seed did not match.',
  too_early: 'The timeout window has not opened yet.',
  already_settled: 'That bet is already settled.',
  luck_low: 'Your LUCK must be full (100).',
  faith_low: 'Not enough FAITH.',
  cooldown: 'Wait a moment and try again.',
  welcome_claimed: 'Welcome chips were already claimed.',
  plot_taken: 'That plot is already owned.',
  plot_gate: 'Earn your standing first.',
  bad_name: 'Give the machine a name (3-16 letters).',
  bankroll_low: 'The machine needs at least 500 chips of bankroll.',
  reserve: 'The machine must keep a 100 chip reserve.',
  not_owner: 'You do not own that machine.',
  rate_limited: 'Slow down a moment.',
  bad_args: 'That request was not accepted.',
  verify: 'Result mismatch, please report this bet',
  quota: 'Too many requests. Wait a little.',
  unknown_account: 'This wallet was not created here.',
};

export function humanError(code: string): string {
  return ERROR_TEXT[code] ?? 'Something went wrong. Try again.';
}
