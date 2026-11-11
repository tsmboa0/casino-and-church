export interface Health {
  ok: boolean;
  contract: string;
  relayer_account: string;
  network: string;
}

export interface PlayerView {
  chips: string;
  luck_milli: number;
  faith_milli: number;
  realm: string;
  stats: {
    spins: number; flips: number; dice: number; roulette: number; candles: number;
    wagered: string; tithed: string; converted_milli: number; faith_earned_milli: number; timeouts: number;
  };
  quests_claimed: number;
  candle_at_ns: string;
  harmony_at_ns: string;
  welcome_claimed: boolean;
}

export interface BetResultView {
  bet_id: number;
  game: string;
  wager: string;
  payout: string;
  blessing: string;
  luck_gain_milli: number;
  outcome: {
    reels?: string[];
    side?: 'H' | 'T' | 'natural' | 'win' | 'push' | 'lose';
    dice?: [number, number];
    n?: number;
    color?: string;
    prize?: number | string;
    dealer_cards?: string[];
  };
  server_seed: string;
  client_seed: string;
  chain_seed: string;
  block_seed: string;
  via: string;
  shoe?: string[];
}

export interface MachineView {
  id: number;
  plot: number;
  owner: string;
  name: string;
  skin: string;
  bankroll: string;
  plays: number;
  earned_net: string;
  deed: string;
}
