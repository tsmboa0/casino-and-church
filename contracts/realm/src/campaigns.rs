//! Church campaigns (the Mission Board beyond the built-in quests).
//!
//! Three kinds:
//! - `social`  (0): follow / share on a social network. Verified off-chain by the Church oracle.
//! - `project` (1): try a project, read its docs, answer about it. Verified by the Church oracle.
//! - `machine` (2): play N rounds on a Founders' Row machine. Verified on chain from per-player play counts.
//!
//! Anyone with FAITH >= 10 can open one, funded from their own chips (rewards are escrowed up front) plus a listing
//! tithe to the treasury (10% of the budget, at least 10 chips). The Church oracle must approve the wording and links
//! first (an ed25519 signature over the exact campaign), which is the moderation step. Claims for social/project
//! campaigns need a fresh oracle signature over (campaign, player, expiry). FAITH from campaigns is capped per player
//! per day. Closing a campaign refunds what is left of the budget to whoever funded it.

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, AccountId};

use crate::events::emit;
use crate::player::add_faith;
use crate::util::{from_hex_32, must};
use crate::Realm;

pub const KIND_SOCIAL: u8 = 0;
pub const KIND_PROJECT: u8 = 1;
pub const KIND_MACHINE: u8 = 2;
const DAY_NS: u64 = 86_400 * 1_000_000_000;
const MAX_REWARD_CHIPS: u32 = 50;
const MAX_REWARD_FAITH_MILLI: u32 = 5_000;
const MAX_CLAIMS: u32 = 500;
const MIN_LISTING_CHIPS: u128 = 10;
const CREATOR_MIN_FAITH_MILLI: u32 = 10_000;
const DAILY_FAITH_CAP_MILLI: u32 = 10_000;
const MAX_LISTED: usize = 40;

#[derive(Clone)]
#[near(serializers = [borsh])]
pub struct Campaign {
    pub id: u32,
    pub kind: u8,
    pub creator: AccountId,
    pub title: String,
    pub url: String,
    pub machine_id: u32,
    pub goal: u32,
    pub reward_chips: u32,
    pub reward_faith_milli: u32,
    pub max_claims: u32,
    pub claims: u32,
    /// escrowed reward budget still unpaid (yocto)
    pub budget: u128,
    pub active: bool,
    /// seeded by the admin and funded from the treasury (the refund goes back there)
    pub from_treasury: bool,
    pub created_ns: u64,
}

#[near(serializers = [borsh])]
pub struct CampaignState {
    pub campaigns: LookupMap<u32, Campaign>,
    pub listed: Vec<u32>,
    pub next_id: u32,
    pub claimed: LookupSet<String>,
    /// "<machine>:<player>" -> settled plays on that machine
    pub machine_plays: LookupMap<String, u32>,
    /// player -> (day, campaign FAITH granted that day, milli)
    pub faith_day: LookupMap<AccountId, (u64, u32)>,
    /// sum of all `budget`s (part of the conserved total)
    pub escrow: u128,
}

impl CampaignState {
    pub fn new() -> Self {
        Self {
            campaigns: LookupMap::new(b"k"),
            listed: Vec::new(),
            next_id: 1,
            claimed: LookupSet::new(b"q"),
            machine_plays: LookupMap::new(b"z"),
            faith_day: LookupMap::new(b"y"),
            escrow: 0,
        }
    }
}

#[near(serializers = [json])]
pub struct NewCampaign {
    pub kind: u8,
    pub title: String,
    pub url: String,
    pub machine_id: u32,
    pub goal: u32,
    pub reward_chips: u32,
    pub reward_faith_milli: u32,
    pub max_claims: u32,
}

#[near(serializers = [json])]
pub struct CampaignView {
    pub id: u32,
    pub kind: u8,
    pub creator: AccountId,
    pub title: String,
    pub url: String,
    pub machine_id: u32,
    pub goal: u32,
    pub reward_chips: u32,
    pub reward_faith_milli: u32,
    pub max_claims: u32,
    pub claims: u32,
    pub active: bool,
    pub claimed: bool,
    pub progress: u32,
}

/// the exact text the Church oracle signs to approve a campaign
pub fn approval_message(creator: &AccountId, c: &NewCampaign, expires_ns: u64) -> String {
    format!(
        "cnc-campaign:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        creator, c.kind, c.title, c.url, c.machine_id, c.goal, c.reward_chips, c.reward_faith_milli, c.max_claims, expires_ns
    )
}
/// the exact text the Church oracle signs to attest that a player did a social/project campaign
pub fn claim_message(id: u32, player: &AccountId, expires_ns: u64) -> String {
    format!("cnc-claim:{id}:{player}:{expires_ns}")
}

fn from_hex_64(s: &str) -> Option<[u8; 64]> {
    if s.len() != 128 {
        return None;
    }
    let a = from_hex_32(&s[..64])?;
    let b = from_hex_32(&s[64..])?;
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&a);
    out[32..].copy_from_slice(&b);
    Some(out)
}

impl Realm {
    fn oracle_signed(&self, message: &str, sig_hex: &str, expires_ns: u64) {
        must(env::block_timestamp() <= expires_ns, "too_late");
        let pk = self.roles.oracle_pk;
        must(pk.is_some(), "not_allowed");
        let sig = from_hex_64(sig_hex);
        must(sig.is_some(), "bad_args");
        must(env::ed25519_verify(&sig.unwrap(), message.as_bytes(), &pk.unwrap()), "bad_signature");
    }

    fn check_new(&self, c: &NewCampaign) {
        must(c.kind <= KIND_MACHINE, "bad_args");
        let t = c.title.trim();
        must((3..=60).contains(&t.chars().count()) && t == c.title, "bad_args");
        must(c.url.len() <= 160 && (c.url.is_empty() || c.url.starts_with("https://")), "bad_args");
        must(c.reward_chips <= MAX_REWARD_CHIPS && c.reward_faith_milli <= MAX_REWARD_FAITH_MILLI, "bad_args");
        must(c.reward_chips > 0 || c.reward_faith_milli > 0, "bad_args");
        must((1..=MAX_CLAIMS).contains(&c.max_claims), "bad_args");
        if c.kind == KIND_MACHINE {
            must(self.machines.get(&c.machine_id).is_some(), "bad_args");
            must((1..=50).contains(&c.goal), "bad_args");
        } else {
            must(c.machine_id == 0 && c.goal == 0 && !c.url.is_empty(), "bad_args");
        }
    }

    fn list(&mut self, c: Campaign) -> u32 {
        let id = c.id;
        self.camp.escrow += c.budget;
        self.camp.campaigns.insert(id, c);
        self.camp.listed.push(id);
        // keep the board short: forget the oldest closed campaigns first
        while self.camp.listed.len() > MAX_LISTED {
            let drop = self.camp.listed.iter().position(|i| self.camp.campaigns.get(i).map(|c| !c.active).unwrap_or(true));
            match drop {
                Some(ix) => { self.camp.listed.remove(ix); }
                None => break,
            }
        }
        emit("campaign_opened", near_sdk::serde_json::json!({ "id": id }));
        id
    }

    /// any player with FAITH >= 10, funded from their chips; the Church oracle approves the exact wording first
    pub(crate) fn create_campaign_inner(&mut self, c: NewCampaign, expires_ns: u64, approval: String) -> u32 {
        self.assert_running();
        self.check_new(&c);
        let creator = env::predecessor_account_id();
        self.oracle_signed(&approval_message(&creator, &c, expires_ns), &approval, expires_ns);
        if c.kind == KIND_MACHINE {
            let m = self.machines.get(&c.machine_id).cloned().unwrap();
            must(self.machine_owner(&m) == creator, "not_owner");
        }
        let chip = self.params.chip_yocto;
        let budget = u128::from(c.reward_chips) * u128::from(c.max_claims) * chip;
        let listing = (budget / 10).max(MIN_LISTING_CHIPS * chip);
        let (mut player, is_new) = self.touch(&creator);
        must(player.faith_milli >= CREATOR_MIN_FAITH_MILLI, "faith_low");
        self.debit(&mut player, budget + listing);
        self.treasury += listing;
        self.save(creator.clone(), player, is_new);
        let id = self.camp.next_id;
        self.camp.next_id += 1;
        self.list(Campaign {
            id, kind: c.kind, creator, title: c.title, url: c.url, machine_id: c.machine_id, goal: c.goal,
            reward_chips: c.reward_chips, reward_faith_milli: c.reward_faith_milli, max_claims: c.max_claims,
            claims: 0, budget, active: true, from_treasury: false, created_ns: env::block_timestamp(),
        })
    }

    /// the Church's own campaigns (e.g. "Follow @NEARProtocol"), funded from the treasury
    pub(crate) fn seed_campaign_inner(&mut self, c: NewCampaign) -> u32 {
        self.assert_running();
        self.assert_admin();
        self.check_new(&c);
        let budget = u128::from(c.reward_chips) * u128::from(c.max_claims) * self.params.chip_yocto;
        must(self.treasury >= budget, "treasury_low");
        self.treasury -= budget;
        let id = self.camp.next_id;
        self.camp.next_id += 1;
        let creator = env::predecessor_account_id();
        self.list(Campaign {
            id, kind: c.kind, creator, title: c.title, url: c.url, machine_id: c.machine_id, goal: c.goal,
            reward_chips: c.reward_chips, reward_faith_milli: c.reward_faith_milli, max_claims: c.max_claims,
            claims: 0, budget, active: true, from_treasury: true, created_ns: env::block_timestamp(),
        })
    }

    /// social/project: needs a fresh oracle attestation; machine: needs `goal` settled plays on that machine
    pub(crate) fn claim_campaign_inner(&mut self, id: u32, expires_ns: u64, attestation: String) {
        self.assert_running();
        let who = env::predecessor_account_id();
        let mut c = self.camp.campaigns.get(&id).cloned().unwrap_or_else(|| env::panic_str("bad_args"));
        must(c.active, "closed");
        let key = format!("{id}:{who}");
        must(!self.camp.claimed.contains(&key), "already_claimed");
        must(c.creator != who, "not_allowed");
        if c.kind == KIND_MACHINE {
            let plays = self.camp.machine_plays.get(&format!("{}:{}", c.machine_id, who)).copied().unwrap_or(0);
            must(plays >= c.goal, "not_done");
        } else {
            self.oracle_signed(&claim_message(id, &who, expires_ns), &attestation, expires_ns);
        }
        let chip = self.params.chip_yocto;
        let chips = u128::from(c.reward_chips) * chip;
        must(c.budget >= chips, "closed");
        let (mut player, is_new) = self.touch(&who);
        // FAITH from campaigns is capped per player per day (the treasury pays the blessing FAITH unlocks)
        let day = env::block_timestamp() / DAY_NS;
        let (d, used) = self.camp.faith_day.get(&who).copied().unwrap_or((day, 0));
        let used = if d == day { used } else { 0 };
        let faith = c.reward_faith_milli.min(DAILY_FAITH_CAP_MILLI.saturating_sub(used));
        let applied = add_faith(&mut player, faith);
        self.camp.faith_day.insert(who.clone(), (day, used + faith));
        c.budget -= chips;
        self.camp.escrow -= chips;
        self.credit(&mut player, chips);
        self.save(who.clone(), player, is_new);
        c.claims += 1;
        self.camp.claimed.insert(key);
        if c.claims >= c.max_claims || c.budget < chips {
            self.close(&mut c);
        }
        self.camp.campaigns.insert(id, c);
        emit("campaign_claimed", near_sdk::serde_json::json!({
            "id": id, "account_id": who.to_string(), "chips": chips.to_string(), "faith_milli": applied,
        }));
    }

    fn close(&mut self, c: &mut Campaign) {
        if !c.active {
            return;
        }
        c.active = false;
        let left = c.budget;
        c.budget = 0;
        self.camp.escrow -= left;
        if c.from_treasury {
            self.treasury += left;
        } else if left > 0 {
            let creator = c.creator.clone();
            let (mut p, is_new) = self.touch(&creator);
            self.credit(&mut p, left);
            self.save(creator, p, is_new);
        }
        emit("campaign_closed", near_sdk::serde_json::json!({ "id": c.id, "refund": left.to_string() }));
    }

    /// the creator (or the admin, as the Church's moderator) closes a campaign; the unpaid budget is refunded
    pub(crate) fn close_campaign_inner(&mut self, id: u32) {
        let who = env::predecessor_account_id();
        let mut c = self.camp.campaigns.get(&id).cloned().unwrap_or_else(|| env::panic_str("bad_args"));
        must(who == c.creator || who == self.roles.admin, "not_allowed");
        self.close(&mut c);
        self.camp.campaigns.insert(id, c);
    }

    /// called when a bet on a machine settles
    pub(crate) fn count_machine_play(&mut self, machine_id: u32, player: &AccountId) {
        let key = format!("{machine_id}:{player}");
        let n = self.camp.machine_plays.get(&key).copied().unwrap_or(0);
        self.camp.machine_plays.insert(key, n.saturating_add(1));
    }

    pub(crate) fn campaigns_view(&self, account: Option<AccountId>) -> Vec<CampaignView> {
        self.camp.listed.iter().rev().filter_map(|id| self.camp.campaigns.get(id)).map(|c| {
            let (claimed, progress) = match &account {
                Some(a) => (
                    self.camp.claimed.contains(&format!("{}:{}", c.id, a)),
                    if c.kind == KIND_MACHINE { self.camp.machine_plays.get(&format!("{}:{}", c.machine_id, a)).copied().unwrap_or(0) } else { 0 },
                ),
                None => (false, 0),
            };
            CampaignView {
                id: c.id, kind: c.kind, creator: c.creator.clone(), title: c.title.clone(), url: c.url.clone(), machine_id: c.machine_id,
                goal: c.goal, reward_chips: c.reward_chips, reward_faith_milli: c.reward_faith_milli, max_claims: c.max_claims,
                claims: c.claims, active: c.active, claimed, progress,
            }
        }).collect()
    }
}
