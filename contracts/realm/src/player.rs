//! Player record, lazy realm decay, and the bet/result records stored beside it.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::AccountId;

use crate::games::GameKind;
use crate::params::{METER_MAX, RESULT_RING};

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum RealmId {
    Plaza,
    Casino,
    Church,
}

pub fn parse_realm(s: &str) -> Option<RealmId> {
    match s {
        "Plaza" | "plaza" => Some(RealmId::Plaza),
        "Casino" | "casino" => Some(RealmId::Casino),
        "Church" | "church" => Some(RealmId::Church),
        _ => None,
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Stats {
    pub spins: u32,
    pub flips: u32,
    pub dice: u32,
    pub roulette: u32,
    pub blackjack: u32,
    pub candles: u32,
    pub wagered: u128,
    pub tithed: u128,
    pub converted_milli: u64,
    pub faith_earned_milli: u64,
    pub timeouts: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Player {
    pub chips: u128,
    pub luck_milli: u32,
    pub faith_milli: u32,
    pub realm: RealmId,
    pub last_update_ns: u64,
    pub last_realm_change_ns: u64,
    pub stats: Stats,
    pub quests_claimed: u32,
    pub candle_at_ns: u64,
    pub harmony_at_ns: u64,
    pub tour_flags: u8,
    pub name: String,
    pub avatar: String,
    pub welcome_claimed: bool,
    pub plot_gate: bool,
    pub recent: [u64; RESULT_RING],
    pub recent_head: u8,
    pub promo_day: u64,
    pub promo_today: u128,
}

impl Player {
    pub fn new(now: u64) -> Self {
        Self {
            chips: 0,
            luck_milli: 0,
            faith_milli: 0,
            realm: RealmId::Plaza,
            last_update_ns: now,
            last_realm_change_ns: 0,
            stats: Stats::default(),
            quests_claimed: 0,
            candle_at_ns: 0,
            harmony_at_ns: 0,
            tour_flags: 0,
            name: String::new(),
            avatar: String::new(),
            welcome_claimed: false,
            plot_gate: false,
            recent: [0; RESULT_RING],
            recent_head: 0,
            promo_day: 0,
            promo_today: 0,
        }
    }
}

/// Lazy decay. The meter of the realm you are NOT in decays. Plaza decays neither.
/// `d = floor(dt_seconds * decay_per_min_milli / 60)`, dt capped at `max_decay_window_s`.
pub fn settle(p: &mut Player, now: u64, decay_per_min_milli: u32, max_decay_window_s: u64) {
    let dt = (now.saturating_sub(p.last_update_ns) / 1_000_000_000).min(max_decay_window_s);
    let d = ((u128::from(dt) * u128::from(decay_per_min_milli)) / 60) as u32;
    match p.realm {
        RealmId::Casino => p.faith_milli = p.faith_milli.saturating_sub(d),
        RealmId::Church => p.luck_milli = p.luck_milli.saturating_sub(d),
        RealmId::Plaza => {}
    }
    p.last_update_ns = now;
}

pub fn add_faith(p: &mut Player, gain: u32) -> u32 {
    let room = METER_MAX - p.faith_milli;
    let applied = gain.min(room);
    p.faith_milli += applied;
    p.stats.faith_earned_milli = p.stats.faith_earned_milli.saturating_add(u64::from(applied));
    applied
}

pub fn add_luck(p: &mut Player, gain: u32) -> u32 {
    let room = METER_MAX - p.luck_milli;
    let applied = gain.min(room);
    p.luck_milli += applied;
    applied
}

pub fn sub_luck(p: &mut Player, amount: u32) {
    p.luck_milli = p.luck_milli.saturating_sub(amount);
}

pub fn sub_faith(p: &mut Player, amount: u32) {
    p.faith_milli = p.faith_milli.saturating_sub(amount);
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Bet {
    pub player: AccountId,
    pub game: GameKind,
    pub machine_id: Option<u32>,
    pub wager: u128,
    pub max_payout: u128,
    /// Vault or machine hold. House bets include the timeout penalty so a max-win timeout cannot overdraw.
    pub hold: u128,
    pub pick: u8,
    pub client_seed: [u8; 32],
    pub chain_seed: [u8; 32],
    pub commit_idx: u64,
    pub placed_height: u64,
    pub placed_ns: u64,
    pub blessing_bps: u16,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct StoredResult {
    pub bet_id: u64,
    pub game: GameKind,
    pub wager: u128,
    pub payout: u128,
    pub blessing: u128,
    pub luck_gain_milli: u32,
    pub reels: Option<Vec<String>>,
    pub side: Option<String>,
    pub dice: Option<[u8; 2]>,
    pub n: Option<u8>,
    pub color: Option<String>,
    pub prize_chips: Option<u32>,
    pub jackpot: bool,
    pub server_seed: [u8; 32],
    pub client_seed: [u8; 32],
    pub chain_seed: [u8; 32],
    pub block_seed: [u8; 32],
    pub settled_height: u64,
    pub via_timeout: bool,
    pub dealer_cards: Option<Vec<String>>,
    pub shoe: Option<Vec<[u8; 32]>>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Machine {
    pub id: u32,
    pub plot: u8,
    pub owner: AccountId,
    pub name: String,
    pub skin: String,
    pub bankroll: u128,
    pub reserved: u128,
    pub plays: u32,
    pub earned_net: i128,
}

pub fn valid_name(name: &str) -> bool {
    let n = name.chars().count();
    (3..=16).contains(&n)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '\'' || c == '-')
}

pub fn valid_avatar(avatar: &str) -> bool {
    let n = avatar.chars().count();
    (1..=24).contains(&n) && avatar.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn valid_skin(skin: &str) -> bool {
    matches!(skin, "gold" | "purple" | "red" | "blue")
}
