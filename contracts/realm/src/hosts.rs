//! Don Fortuna and Father Nakamoto. Policy only: events, alms, and decision logs.
//! Nothing here touches the commit–reveal draws or the paytables.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId};

use crate::events::emit;
use crate::params::within_step;
use crate::util::must;
use crate::{Realm, RealmExt};

const DAY_NS: u64 = 86_400 * 1_000_000_000;
const GAP_NS: u64 = 90 * 60 * 1_000_000_000;
const PRIEST_COOLDOWN_NS: u64 = 30 * 60 * 1_000_000_000;
const ALMS_GAP_NS: u64 = DAY_NS;
const ALMS_FLOOR_CHIPS: u128 = 100;

#[derive(Clone)]
#[near(serializers = [borsh])]
pub struct TimedEvent {
    pub kind: u8,
    pub boost_bps: u32,
    pub started_ns: u64,
    pub ends_ns: u64,
    pub by: AccountId,
}

#[near(serializers = [borsh])]
pub struct HostState {
    pub priest: AccountId,
    pub active: Vec<Option<TimedEvent>>,
    pub last_start_ns: Vec<u64>,
    pub day_id: u64,
    pub events_today: Vec<u32>,
    pub alms_day: u64,
    pub alms_base: u128,
    pub alms_spent: u128,
    pub last_alms_ns: LookupMap<AccountId, u64>,
    pub priest_change_ns: u64,
    pub candle_faith_milli: u32,
    pub topup_day: u64,
    pub topup_spent_chips: u32,
}

impl HostState {
    pub fn new(priest: AccountId) -> Self {
        Self {
            priest,
            active: vec![None, None],
            last_start_ns: vec![0, 0],
            day_id: 0,
            events_today: vec![0, 0],
            alms_day: 0,
            alms_base: 0,
            alms_spent: 0,
            last_alms_ns: LookupMap::new(b"h"),
            priest_change_ns: 0,
            candle_faith_milli: 3_000,
            topup_day: 0,
            topup_spent_chips: 0,
        }
    }
}

#[near(serializers = [json])]
pub struct EventView {
    pub kind: String,
    pub realm: String,
    pub started_ns: String,
    pub ends_ns: String,
    pub boost_bps: u32,
    pub by: AccountId,
}

#[near(serializers = [json])]
pub struct AgentProof {
    pub decision_id: String,
    pub agent: String,
    pub action: String,
    pub model: String,
    pub signed_text: String,
    pub signature: String,
    pub signing_address: String,
    pub request_sha256: String,
    pub response_sha256: String,
}

/// What a host does in the same call that anchors its decision (see `host_act`).
#[near(serializers = [json])]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum HostCall {
    None,
    SetParams { patch: crate::params::ParamsPatch },
    StartEvent { kind: String, minutes: u32, boost_bps: u32 },
    EndEvent { kind: String },
    TopUpJackpot { chips: u32 },
    GrantAlms { player: AccountId, chips: u32 },
    SetChurchParams { patch: ChurchPatch },
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ChurchPatch {
    pub blessing_day_cap_bps: Option<u32>,
    pub candle_faith_milli: Option<u32>,
}

fn utc_day(ns: u64) -> u64 {
    ns / DAY_NS
}

fn kind_index(kind: &str) -> Option<usize> {
    match kind {
        "happy_hour" => Some(0),
        "vigil" => Some(1),
        _ => None,
    }
}

#[near]
impl Realm {
    pub(crate) fn assert_priest(&self) {
        let id = env::predecessor_account_id();
        must(id == self.hosts.priest || id == self.roles.admin, "not_allowed");
    }

    fn roll_host_day(&mut self) {
        let day = utc_day(env::block_timestamp());
        if day != self.hosts.day_id {
            self.hosts.day_id = day;
            self.hosts.events_today = vec![0, 0];
        }
        if day != self.hosts.alms_day {
            self.hosts.alms_day = day;
            self.hosts.alms_base = self.treasury;
            self.hosts.alms_spent = 0;
        }
        if day != self.hosts.topup_day {
            self.hosts.topup_day = day;
            self.hosts.topup_spent_chips = 0;
        }
    }

    fn live_event(&self, idx: usize) -> Option<&TimedEvent> {
        let event = self.hosts.active.get(idx)?.as_ref()?;
        if env::block_timestamp() >= event.ends_ns {
            None
        } else {
            Some(event)
        }
    }

    pub(crate) fn luck_award(&self, wager_chips: u32) -> u32 {
        let mut raw = wager_chips.saturating_mul(self.params.luck_per_chip_milli);
        let mut cap = self.params.luck_per_bet_cap_milli;
        if self.live_event(0).is_some() {
            let boost = self.live_event(0).unwrap().boost_bps;
            raw = ((u128::from(raw) * (10_000 + u128::from(boost))) / 10_000) as u32;
            cap = cap.saturating_mul(3) / 2;
        }
        raw.min(cap)
    }

    pub(crate) fn faith_award(&self, raw: u32) -> u32 {
        if let Some(event) = self.live_event(1) {
            ((u128::from(raw) * (10_000 + u128::from(event.boost_bps))) / 10_000) as u32
        } else {
            raw
        }
    }

    pub(crate) fn candle_faith(&self) -> u32 {
        self.faith_award(self.hosts.candle_faith_milli)
    }

    pub fn set_priest(&mut self, priest: AccountId) {
        let id = env::predecessor_account_id();
        must(id == self.roles.admin, "not_allowed");
        self.hosts.priest = priest.clone();
        emit("roles_changed", near_sdk::serde_json::json!({ "priest": priest.to_string() }));
    }

    pub fn start_event(&mut self, kind: String, minutes: u32, boost_bps: u32) {
        self.assert_running();
        let idx = kind_index(&kind).unwrap_or_else(|| {
            must(false, "bad_args");
            0
        });
        if idx == 0 {
            self.assert_agent();
        } else {
            self.assert_priest();
        }
        must((10..=60).contains(&minutes), "bad_args");
        must((1_000..=5_000).contains(&boost_bps), "bad_args");
        self.roll_host_day();
        must(self.hosts.events_today[idx] < 4, "rate_limited");
        let now = env::block_timestamp();
        must(now >= self.hosts.last_start_ns[idx].saturating_add(GAP_NS), "cooldown");
        if self.live_event(idx).is_some() {
            must(false, "bad_args");
        }
        self.hosts.active[idx] = None;
        let ends = now.saturating_add(u64::from(minutes) * 60 * 1_000_000_000);
        let by = env::predecessor_account_id();
        self.hosts.active[idx] = Some(TimedEvent { kind: idx as u8, boost_bps, started_ns: now, ends_ns: ends, by: by.clone() });
        self.hosts.last_start_ns[idx] = now;
        self.hosts.events_today[idx] += 1;
        emit("event_started", near_sdk::serde_json::json!({
            "kind": kind,
            "realm": if idx == 0 { "casino" } else { "church" },
            "minutes": minutes,
            "boost_bps": boost_bps,
            "ends_ns": ends.to_string(),
            "by": by.to_string(),
        }));
    }

    pub fn end_event(&mut self, kind: String) {
        self.assert_running();
        let idx = kind_index(&kind).unwrap_or_else(|| {
            must(false, "bad_args");
            0
        });
        if idx == 0 {
            self.assert_agent();
        } else {
            self.assert_priest();
        }
        must(self.live_event(idx).is_some(), "bad_args");
        self.hosts.active[idx] = None;
        emit("event_ended", near_sdk::serde_json::json!({ "kind": kind, "by": env::predecessor_account_id().to_string() }));
    }

    pub fn get_events(&self) -> Vec<EventView> {
        let mut out = Vec::new();
        for idx in 0..2 {
            if let Some(event) = self.live_event(idx) {
                out.push(EventView {
                    kind: if idx == 0 { "happy_hour" } else { "vigil" }.to_string(),
                    realm: if idx == 0 { "casino" } else { "church" }.to_string(),
                    started_ns: event.started_ns.to_string(),
                    ends_ns: event.ends_ns.to_string(),
                    boost_bps: event.boost_bps,
                    by: event.by.clone(),
                });
            }
        }
        out
    }

    pub fn grant_alms(&mut self, player: AccountId, chips: u32) {
        self.assert_running();
        self.assert_priest();
        must((1..=50).contains(&chips), "bad_args");
        self.roll_host_day();
        let chip = self.params.chip_yocto;
        let amount = u128::from(chips) * chip;
        let (mut who, is_new) = self.touch(&player);
        must(who.chips < 50 * chip, "not_allowed");
        must(who.stats.wagered >= 100 * chip || who.stats.candles >= 1, "not_allowed");
        let last = self.hosts.last_alms_ns.get(&player).copied().unwrap_or(0);
        must(env::block_timestamp() >= last.saturating_add(ALMS_GAP_NS), "cooldown");
        // 2% of the day's opening treasury, but never less than 100 chips (a small treasury still feeds the poor)
        let cap = (self.hosts.alms_base * 200 / 10_000).max(ALMS_FLOOR_CHIPS * chip);
        must(self.hosts.alms_spent.saturating_add(amount) <= cap, "treasury_low");
        must(self.treasury >= amount, "treasury_low");
        self.treasury -= amount;
        self.credit(&mut who, amount);
        self.hosts.alms_spent += amount;
        self.hosts.last_alms_ns.insert(player.clone(), env::block_timestamp());
        self.save(player.clone(), who, is_new);
        emit("alms_granted", near_sdk::serde_json::json!({
            "account_id": player.to_string(),
            "chips": chips.to_string(),
            "amount": amount.to_string(),
        }));
    }

    pub fn set_church_params(&mut self, patch: ChurchPatch) {
        self.assert_running();
        self.assert_priest();
        must(patch.blessing_day_cap_bps.is_some() || patch.candle_faith_milli.is_some(), "bad_args");
        let now = env::block_timestamp();
        let admin = env::predecessor_account_id() == self.roles.admin;
        if !admin {
            must(now >= self.hosts.priest_change_ns.saturating_add(PRIEST_COOLDOWN_NS), "cooldown");
        }
        if let Some(v) = patch.blessing_day_cap_bps {
            must((100..=1_000).contains(&v), "bad_args");
            if !admin {
                must(within_step(self.params.blessing_day_cap_bps, v), "bad_args");
            }
            self.params.blessing_day_cap_bps = v;
        }
        if let Some(v) = patch.candle_faith_milli {
            must((2_000..=4_000).contains(&v), "bad_args");
            if !admin {
                must(within_step(self.hosts.candle_faith_milli, v), "bad_args");
            }
            self.hosts.candle_faith_milli = v;
        }
        if !admin {
            self.hosts.priest_change_ns = now;
        }
        emit("params_changed", near_sdk::serde_json::json!({
            "account_id": env::predecessor_account_id().to_string(),
            "blessing_day_cap_bps": self.params.blessing_day_cap_bps,
            "candle_faith_milli": self.hosts.candle_faith_milli,
        }));
    }

    pub fn top_up_jackpot(&mut self, chips: u32) {
        self.assert_running();
        self.assert_agent();
        must((1..=500).contains(&chips), "bad_args");
        self.roll_host_day();
        must(self.hosts.topup_spent_chips.saturating_add(chips) <= 2_000, "vault_low");
        let amount = u128::from(chips) * self.params.chip_yocto;
        let free = self.vault.saturating_sub(self.reserved);
        must(free >= 3 * (self.reserved.saturating_add(amount)), "vault_low");
        must(self.vault >= amount, "vault_low");
        self.vault -= amount;
        self.jackpot += amount;
        self.hosts.topup_spent_chips += chips;
        emit("jackpot_topped_up", near_sdk::serde_json::json!({
            "chips": chips.to_string(),
            "amount": amount.to_string(),
            "by": env::predecessor_account_id().to_string(),
        }));
    }

    pub fn record_decision(&mut self, proof: AgentProof) {
        self.assert_running();
        let id = env::predecessor_account_id();
        must(id == self.roles.agent || id == self.hosts.priest || id == self.roles.admin, "not_allowed");
        must(proof.agent == "fortuna" || proof.agent == "nakamoto", "bad_args");
        must(proof.signed_text.len() <= 300, "bad_args");
        must(proof.signature.len() == 130 && proof.signature.chars().all(|c| c.is_ascii_hexdigit()), "bad_args");
        must(proof.decision_id.len() <= 64 && proof.action.len() <= 64, "bad_args");
        must(proof.model.len() <= 80 && proof.signing_address.len() <= 42, "bad_args");
        must(proof.request_sha256.len() == 64 && proof.response_sha256.len() == 64, "bad_args");
        emit("agent_decision", near_sdk::serde_json::json!({
            "decision_id": proof.decision_id,
            "agent": proof.agent,
            "action": proof.action,
            "model": proof.model,
            "signed_text": proof.signed_text,
            "signature": proof.signature,
            "signing_address": proof.signing_address,
            "request_sha256": proof.request_sha256,
            "response_sha256": proof.response_sha256,
        }));
    }

    /// One AI decision, anchored and acted on in ONE function call: the `agent_decision` event (the signed proof)
    /// and the action succeed or fail together. A function-call access key can sign it (one action, one method).
    /// Every bound of the underlying method still applies; Don may only use his tools, the Father only his.
    pub fn host_act(&mut self, proof: AgentProof, call: HostCall) {
        let id = env::predecessor_account_id();
        let admin = id == self.roles.admin;
        match proof.agent.as_str() {
            "fortuna" => must(admin || id == self.roles.agent, "not_allowed"),
            "nakamoto" => must(admin || id == self.hosts.priest, "not_allowed"),
            _ => must(false, "bad_args"),
        }
        let don = proof.agent == "fortuna";
        self.record_decision(proof);
        match call {
            HostCall::None => {}
            HostCall::SetParams { patch } => {
                must(don, "not_allowed");
                self.set_params_inner(patch);
            }
            HostCall::StartEvent { kind, minutes, boost_bps } => self.start_event(kind, minutes, boost_bps),
            HostCall::EndEvent { kind } => self.end_event(kind),
            HostCall::TopUpJackpot { chips } => self.top_up_jackpot(chips),
            HostCall::GrantAlms { player, chips } => self.grant_alms(player, chips),
            HostCall::SetChurchParams { patch } => self.set_church_params(patch),
        }
    }
}
