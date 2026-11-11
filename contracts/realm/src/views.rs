//! Read-only views. `get_player` applies decay virtually and does not write.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::{env, AccountId};

use crate::games::{blessing_bps, GameKind};
use crate::params::RESULT_RING;
use crate::player::{settle, Bet, Player, StoredResult};
use crate::util::to_hex;
use crate::Realm;

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StatsView {
    pub spins: u32,
    pub flips: u32,
    pub dice: u32,
    pub roulette: u32,
    pub blackjack: u32,
    pub candles: u32,
    pub wagered: U128,
    pub tithed: U128,
    pub converted_milli: u64,
    pub faith_earned_milli: u64,
    pub timeouts: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PlayerView {
    pub account_id: AccountId,
    pub name: String,
    pub avatar: String,
    pub chips: U128,
    pub luck_milli: u32,
    pub faith_milli: u32,
    pub realm: String,
    pub stats: StatsView,
    pub quests_claimed: u32,
    pub candle_at_ns: U64,
    pub harmony_at_ns: U64,
    pub tour_flags: u8,
    pub welcome_claimed: bool,
    pub blessing_bps: u16,
    pub plot_gate_granted: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", untagged)]
pub enum PrizeJson {
    Chips(u32),
    Label(String),
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct OutcomeView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dice: Option<[u8; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prize: Option<PrizeJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dealer_cards: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BetResultView {
    pub bet_id: u64,
    pub game: GameKind,
    pub wager: U128,
    pub payout: U128,
    pub blessing: U128,
    pub luck_gain_milli: u32,
    pub outcome: OutcomeView,
    pub server_seed: String,
    pub client_seed: String,
    pub chain_seed: String,
    pub block_seed: String,
    pub settled_height: u64,
    pub via: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shoe: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BetView {
    pub bet_id: u64,
    pub player: AccountId,
    pub game: GameKind,
    pub wager: U128,
    pub pick: u8,
    pub commit_idx: u64,
    pub placed_height: u64,
    pub machine_id: Option<u32>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PoolsView {
    pub vault: U128,
    pub reserved: U128,
    pub vault_free: U128,
    pub treasury: U128,
    pub jackpot: U128,
    pub machine_reserved: U128,
    pub commits_available: u64,
    pub next_bet_id: u64,
    pub commit_head: u64,
    pub commit_tail: u64,
    pub pending_bets: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ParamsView {
    pub chip_yocto: U128,
    pub luck_per_chip_milli: u32,
    pub luck_per_bet_cap_milli: u32,
    pub decay_per_min_milli: u32,
    pub max_decay_window_s: u64,
    pub offer_ratio_bps: u32,
    pub candle_faith_milli: u32,
    pub candle_cooldown_s: u64,
    pub harmony_cooldown_s: u64,
    pub harmony_cost_milli: u32,
    pub welcome_grant_chips: u32,
    pub treasury_bps: u32,
    pub jackpot_bps: u32,
    pub max_bet_chips: u32,
    pub reveal_timeout_blocks: u64,
    pub timeout_penalty_bps: u32,
    pub blessing_day_cap_bps: u32,
    pub welcome_cap_total_chips: u64,
    pub promo_day_cap_chips: u64,
    pub promo_player_cap_chips: u64,
    pub allowed_wagers: Vec<u32>,
    pub effective_max_bet_chips: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MachineView {
    pub id: u32,
    pub plot: u8,
    pub owner: AccountId,
    pub name: String,
    pub skin: String,
    pub bankroll: U128,
    pub reserved: U128,
    pub plays: u32,
    pub earned_net: String,
    pub deed: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageReport {
    pub version: u32,
    pub total_players: u32,
    pub pending_bets: u64,
    pub chips_outstanding: U128,
    pub machine_bankroll: U128,
    pub liabilities: U128,
    pub storage_bytes: u64,
    pub contract_balance: U128,
    pub paused: bool,
}

fn result_key(account: &AccountId, bet_id: u64) -> String {
    format!("{account}:{bet_id}")
}

fn outcome_of(r: &StoredResult) -> OutcomeView {
    let prize = if r.jackpot {
        Some(PrizeJson::Label("JACKPOT".into()))
    } else {
        r.prize_chips.map(PrizeJson::Chips)
    };
    OutcomeView {
        reels: r.reels.clone(),
        side: r.side.clone(),
        dice: r.dice,
        n: r.n,
        color: r.color.clone(),
        prize,
        dealer_cards: r.dealer_cards.clone(),
    }
}

fn result_view(r: &StoredResult) -> BetResultView {
    BetResultView {
        bet_id: r.bet_id,
        game: r.game,
        wager: U128(r.wager),
        payout: U128(r.payout),
        blessing: U128(r.blessing),
        luck_gain_milli: r.luck_gain_milli,
        outcome: outcome_of(r),
        server_seed: if r.via_timeout { String::new() } else { to_hex(&r.server_seed) },
        client_seed: to_hex(&r.client_seed),
        chain_seed: to_hex(&r.chain_seed),
        block_seed: if r.via_timeout { to_hex(&r.block_seed) } else { String::new() },
        settled_height: r.settled_height,
        via: if r.via_timeout { "timeout".into() } else { "reveal".into() },
        shoe: r.shoe.as_ref().map(|seeds| seeds.iter().map(|s| to_hex(s)).collect()),
    }
}

fn bet_view(id: u64, bet: &Bet) -> BetView {
    BetView {
        bet_id: id,
        player: bet.player.clone(),
        game: bet.game,
        wager: U128(bet.wager),
        pick: bet.pick,
        commit_idx: bet.commit_idx,
        placed_height: bet.placed_height,
        machine_id: bet.machine_id,
    }
}

impl Realm {
    pub(crate) fn view_player(&self, account_id: AccountId) -> Option<PlayerView> {
        let stored = self.players.get(&account_id).cloned()?;
        let mut player: Player = stored;
        settle(
            &mut player,
            env::block_timestamp(),
            self.params.decay_per_min_milli,
            self.params.max_decay_window_s,
        );
        let realm = match player.realm {
            crate::player::RealmId::Plaza => "Plaza",
            crate::player::RealmId::Casino => "Casino",
            crate::player::RealmId::Church => "Church",
        };
        Some(PlayerView {
            account_id,
            name: player.name,
            avatar: player.avatar,
            chips: U128(player.chips),
            luck_milli: player.luck_milli,
            faith_milli: player.faith_milli,
            realm: realm.into(),
            stats: StatsView {
                spins: player.stats.spins,
                flips: player.stats.flips,
                dice: player.stats.dice,
                roulette: player.stats.roulette,
                blackjack: player.stats.blackjack,
                candles: player.stats.candles,
                wagered: U128(player.stats.wagered),
                tithed: U128(player.stats.tithed),
                converted_milli: player.stats.converted_milli,
                faith_earned_milli: player.stats.faith_earned_milli,
                timeouts: player.stats.timeouts,
            },
            quests_claimed: player.quests_claimed,
            candle_at_ns: U64(player.candle_at_ns),
            harmony_at_ns: U64(player.harmony_at_ns),
            tour_flags: player.tour_flags,
            welcome_claimed: player.welcome_claimed,
            blessing_bps: blessing_bps(player.faith_milli),
            plot_gate_granted: player.plot_gate,
        })
    }

    pub(crate) fn view_bet(&self, bet_id: u64) -> Option<BetView> {
        self.bets.get(&bet_id).map(|bet| bet_view(bet_id, bet))
    }

    pub(crate) fn view_bets(&self, from_id: u64, limit: u32) -> Vec<Option<BetView>> {
        let limit = u64::from(limit.min(50));
        (0..limit).map(|i| self.view_bet(from_id.saturating_add(i))).collect()
    }

    pub(crate) fn view_bet_result(&self, account_id: AccountId, bet_id: u64) -> Option<BetResultView> {
        self.results.get(&result_key(&account_id, bet_id)).map(|r| result_view(r))
    }

    pub(crate) fn view_recent(&self, account_id: AccountId) -> Vec<BetResultView> {
        let Some(player) = self.players.get(&account_id) else { return Vec::new() };
        let head = player.recent_head as usize;
        let mut ids = Vec::new();
        if player.recent[head] == 0 {
            for i in 0..head {
                ids.push(player.recent[i]);
            }
        } else {
            for i in 0..RESULT_RING {
                let id = player.recent[(head + i) % RESULT_RING];
                if id != 0 {
                    ids.push(id);
                }
            }
        }
        ids.into_iter().filter_map(|id| self.view_bet_result(account_id.clone(), id)).collect()
    }

    pub(crate) fn view_pools(&self) -> PoolsView {
        let free = self.vault.saturating_sub(self.reserved);
        PoolsView {
            vault: U128(self.vault),
            reserved: U128(self.reserved),
            vault_free: U128(free),
            treasury: U128(self.treasury),
            jackpot: U128(self.jackpot),
            machine_reserved: U128(self.machine_reserved),
            commits_available: self.commit_tail.saturating_sub(self.commit_head),
            next_bet_id: self.next_bet_id,
            commit_head: self.commit_head,
            commit_tail: self.commit_tail,
            pending_bets: self.pending_bets,
        }
    }

    pub(crate) fn view_params(&self) -> ParamsView {
        let p = &self.params;
        let free_chips = (self.vault.saturating_sub(self.reserved) / p.chip_yocto) / 200;
        ParamsView {
            chip_yocto: U128(p.chip_yocto),
            luck_per_chip_milli: p.luck_per_chip_milli,
            luck_per_bet_cap_milli: p.luck_per_bet_cap_milli,
            decay_per_min_milli: p.decay_per_min_milli,
            max_decay_window_s: p.max_decay_window_s,
            offer_ratio_bps: p.offer_ratio_bps,
            candle_faith_milli: self.hosts.candle_faith_milli,
            candle_cooldown_s: p.candle_cooldown_s,
            harmony_cooldown_s: p.harmony_cooldown_s,
            harmony_cost_milli: p.harmony_cost_milli,
            welcome_grant_chips: p.welcome_grant_chips,
            treasury_bps: 50,
            jackpot_bps: 25,
            max_bet_chips: p.max_bet_chips,
            reveal_timeout_blocks: p.reveal_timeout_blocks,
            timeout_penalty_bps: p.timeout_penalty_bps,
            blessing_day_cap_bps: p.blessing_day_cap_bps,
            welcome_cap_total_chips: p.welcome_cap_total_chips,
            promo_day_cap_chips: p.promo_day_cap_chips,
            promo_player_cap_chips: p.promo_player_cap_chips,
            allowed_wagers: p.allowed_wagers.clone(),
            effective_max_bet_chips: free_chips.min(u128::from(p.max_bet_chips)) as u64,
        }
    }

    pub(crate) fn view_machine(&self, id: u32) -> Option<MachineView> {
        let machine = self.machines.get(&id).cloned()?;
        Some(MachineView {
            id: machine.id,
            plot: machine.plot,
            owner: self.machine_owner(&machine),
            name: machine.name,
            skin: machine.skin,
            bankroll: U128(machine.bankroll),
            reserved: U128(machine.reserved),
            plays: machine.plays,
            earned_net: machine.earned_net.to_string(),
            deed: format!("deed:machine:{}", machine.id),
        })
    }

    pub(crate) fn view_plots(&self) -> Vec<Option<MachineView>> {
        (1..=3u8).map(|plot| self.plots.get(&plot).copied().and_then(|id| self.view_machine(id))).collect()
    }

    pub(crate) fn view_storage(&self) -> StorageReport {
        StorageReport {
            version: self.version,
            total_players: self.total_players,
            pending_bets: self.pending_bets,
            chips_outstanding: U128(self.chips_outstanding),
            machine_bankroll: U128(self.machine_bankroll_total),
            liabilities: U128(self.liability_total()),
            storage_bytes: env::storage_usage(),
            contract_balance: U128(env::account_balance().as_yoctonear()),
            paused: self.roles.paused,
        }
    }
}
