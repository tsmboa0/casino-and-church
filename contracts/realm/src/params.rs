//! Bounded economy parameters. Paytables are not in here; they are constants in `games`.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};

use crate::util::must;

pub const DEFAULT_CHIP_YOCTO: u128 = 10_000_000_000_000_000_000_000; // 10^22 = 0.01 NEAR
pub const TREASURY_BPS: u128 = 50;
pub const JACKPOT_BPS: u128 = 25;
pub const PROTOCOL_BPS: u128 = 100;
pub const AGENT_COOLDOWN_NS: u64 = 300 * 1_000_000_000;
pub const REALM_COOLDOWN_NS: u64 = 3 * 1_000_000_000;
pub const METER_MAX: u32 = 100_000;
pub const RESULT_RING: usize = 50;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Params {
    pub chip_yocto: u128,
    pub luck_per_chip_milli: u32,
    pub luck_per_bet_cap_milli: u32,
    pub decay_per_min_milli: u32,
    pub max_decay_window_s: u64,
    pub offer_ratio_bps: u32,
    pub candle_cooldown_s: u64,
    pub harmony_cooldown_s: u64,
    pub harmony_cost_milli: u32,
    pub welcome_grant_chips: u32,
    pub max_bet_chips: u32,
    pub reveal_timeout_blocks: u64,
    pub timeout_penalty_bps: u32,
    pub blessing_day_cap_bps: u32,
    pub welcome_cap_total_chips: u64,
    pub promo_day_cap_chips: u64,
    pub promo_player_cap_chips: u64,
    pub allowed_wagers: Vec<u32>,
}

impl Params {
    pub fn production(chip_yocto: u128) -> Self {
        Self {
            chip_yocto,
            luck_per_chip_milli: 80,
            luck_per_bet_cap_milli: 8_000,
            decay_per_min_milli: 500,
            max_decay_window_s: 900,
            offer_ratio_bps: 8_000,
            candle_cooldown_s: 86_400,
            harmony_cooldown_s: 86_400,
            harmony_cost_milli: 20_000,
            welcome_grant_chips: 500,
            max_bet_chips: 100,
            reveal_timeout_blocks: 60,
            timeout_penalty_bps: 1_000,
            blessing_day_cap_bps: 500,
            welcome_cap_total_chips: 25_000,
            promo_day_cap_chips: 1_000,
            promo_player_cap_chips: 200,
            allowed_wagers: vec![10, 25, 50, 100],
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(crate = "near_sdk::serde", default)]
pub struct ParamsPatch {
    pub luck_per_chip_milli: Option<u32>,
    pub luck_per_bet_cap_milli: Option<u32>,
    pub decay_per_min_milli: Option<u32>,
    pub max_decay_window_s: Option<u64>,
    pub offer_ratio_bps: Option<u32>,
    pub candle_cooldown_s: Option<u64>,
    pub harmony_cooldown_s: Option<u64>,
    pub harmony_cost_milli: Option<u32>,
    pub welcome_grant_chips: Option<u32>,
    pub max_bet_chips: Option<u32>,
    pub reveal_timeout_blocks: Option<u64>,
    pub timeout_penalty_bps: Option<u32>,
    pub blessing_day_cap_bps: Option<u32>,
    pub welcome_cap_total_chips: Option<u64>,
    pub promo_day_cap_chips: Option<u64>,
    pub promo_player_cap_chips: Option<u64>,
    pub allowed_wagers: Option<Vec<u32>>,
}

impl ParamsPatch {
    pub fn agent_only(&self) -> bool {
        self.luck_per_bet_cap_milli.is_none()
            && self.decay_per_min_milli.is_none()
            && self.max_decay_window_s.is_none()
            && self.offer_ratio_bps.is_none()
            && self.candle_cooldown_s.is_none()
            && self.harmony_cooldown_s.is_none()
            && self.harmony_cost_milli.is_none()
            && self.welcome_grant_chips.is_none()
            && self.reveal_timeout_blocks.is_none()
            && self.timeout_penalty_bps.is_none()
            && self.blessing_day_cap_bps.is_none()
            && self.welcome_cap_total_chips.is_none()
            && self.promo_day_cap_chips.is_none()
            && self.promo_player_cap_chips.is_none()
            && self.allowed_wagers.is_none()
            && (self.luck_per_chip_milli.is_some() || self.max_bet_chips.is_some())
    }

    pub fn is_empty(&self) -> bool {
        self.luck_per_chip_milli.is_none()
            && self.luck_per_bet_cap_milli.is_none()
            && self.decay_per_min_milli.is_none()
            && self.max_decay_window_s.is_none()
            && self.offer_ratio_bps.is_none()
            && self.candle_cooldown_s.is_none()
            && self.harmony_cooldown_s.is_none()
            && self.harmony_cost_milli.is_none()
            && self.welcome_grant_chips.is_none()
            && self.max_bet_chips.is_none()
            && self.reveal_timeout_blocks.is_none()
            && self.timeout_penalty_bps.is_none()
            && self.blessing_day_cap_bps.is_none()
            && self.welcome_cap_total_chips.is_none()
            && self.promo_day_cap_chips.is_none()
            && self.promo_player_cap_chips.is_none()
            && self.allowed_wagers.is_none()
    }
}

fn in_u32(v: u32, lo: u32, hi: u32) -> bool {
    (lo..=hi).contains(&v)
}
fn in_u64(v: u64, lo: u64, hi: u64) -> bool {
    (lo..=hi).contains(&v)
}

/// Single step of at most 25% (agent). `old == 0` is rejected.
pub fn within_step(old: u32, new: u32) -> bool {
    if old == 0 {
        return false;
    }
    let old = u64::from(old);
    let new = u64::from(new);
    let delta = if new > old { new - old } else { old - new };
    delta * 100 <= old * 25
}

impl Params {
    pub fn validate(&self) {
        must(self.chip_yocto > 0, "bad_args");
        must(in_u32(self.luck_per_chip_milli, 20, 120), "bad_args");
        must(in_u32(self.luck_per_bet_cap_milli, 2_000, 12_000), "bad_args");
        must(in_u32(self.decay_per_min_milli, 100, 2_000), "bad_args");
        must(in_u64(self.max_decay_window_s, 60, 3_600), "bad_args");
        must(in_u32(self.offer_ratio_bps, 5_000, 10_000), "bad_args");
        must(in_u64(self.candle_cooldown_s, 10, 86_400), "bad_args");
        must(in_u64(self.harmony_cooldown_s, 60, 86_400), "bad_args");
        must(in_u32(self.harmony_cost_milli, 10_000, METER_MAX), "bad_args");
        must(self.welcome_grant_chips <= 1_000, "bad_args");
        must(in_u32(self.max_bet_chips, 10, 500), "bad_args");
        must(in_u64(self.reveal_timeout_blocks, 20, 600), "bad_args");
        must(self.timeout_penalty_bps <= 5_000, "bad_args");
        must(self.blessing_day_cap_bps <= 2_000, "bad_args");
        must(self.welcome_cap_total_chips <= 1_000_000, "bad_args");
        must(self.promo_day_cap_chips <= 1_000_000, "bad_args");
        must(self.promo_player_cap_chips <= self.promo_day_cap_chips, "bad_args");
        must((1..=8).contains(&self.allowed_wagers.len()), "bad_args");
        let mut seen = Vec::new();
        for w in &self.allowed_wagers {
            must(*w >= 1 && *w <= self.max_bet_chips, "bad_args");
            must(!seen.contains(w), "bad_args");
            seen.push(*w);
        }
    }

    pub fn apply(&mut self, patch: &ParamsPatch) {
        if let Some(v) = patch.luck_per_chip_milli {
            self.luck_per_chip_milli = v;
        }
        if let Some(v) = patch.luck_per_bet_cap_milli {
            self.luck_per_bet_cap_milli = v;
        }
        if let Some(v) = patch.decay_per_min_milli {
            self.decay_per_min_milli = v;
        }
        if let Some(v) = patch.max_decay_window_s {
            self.max_decay_window_s = v;
        }
        if let Some(v) = patch.offer_ratio_bps {
            self.offer_ratio_bps = v;
        }
        if let Some(v) = patch.candle_cooldown_s {
            self.candle_cooldown_s = v;
        }
        if let Some(v) = patch.harmony_cooldown_s {
            self.harmony_cooldown_s = v;
        }
        if let Some(v) = patch.harmony_cost_milli {
            self.harmony_cost_milli = v;
        }
        if let Some(v) = patch.welcome_grant_chips {
            self.welcome_grant_chips = v;
        }
        if let Some(v) = patch.max_bet_chips {
            self.max_bet_chips = v;
        }
        if let Some(v) = patch.reveal_timeout_blocks {
            self.reveal_timeout_blocks = v;
        }
        if let Some(v) = patch.timeout_penalty_bps {
            self.timeout_penalty_bps = v;
        }
        if let Some(v) = patch.blessing_day_cap_bps {
            self.blessing_day_cap_bps = v;
        }
        if let Some(v) = patch.welcome_cap_total_chips {
            self.welcome_cap_total_chips = v;
        }
        if let Some(v) = patch.promo_day_cap_chips {
            self.promo_day_cap_chips = v;
        }
        if let Some(v) = patch.promo_player_cap_chips {
            self.promo_player_cap_chips = v;
        }
        if let Some(v) = &patch.allowed_wagers {
            self.allowed_wagers = v.clone();
        } else {
            // An agent may only move max_bet. Drop quotes the new ceiling no longer allows.
            self.allowed_wagers.retain(|w| *w <= self.max_bet_chips);
        }
        self.validate();
    }
}
