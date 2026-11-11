//! The Casino & The Church realm contract.
//!
//! One account holds the chip ledger, the dealer commit pool, church pools, and plot deeds.
//! Relayed calls arrive as the player (NEP-366). Only `deposit` and the seed methods are payable.

mod blackjack;
mod campaigns;
mod church;
mod events;
mod games;
mod hosts;
mod ledger;
mod machines;
mod mt;
mod params;
mod player;
mod rng;
mod roles;
mod util;
mod views;

use near_sdk::store::LookupMap;
use near_sdk::{env, json_types::U128, near, AccountId, PanicOnDefault, Promise};
use crate::params::{Params, ParamsPatch, DEFAULT_CHIP_YOCTO};
use crate::roles::Roles;
use crate::views::{BetResultView, BetView, MachineView, ParamsView, PlayerView, PoolsView, StorageReport};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Realm {
    pub version: u32,
    pub roles: Roles,
    pub params: Params,
    pub players: LookupMap<AccountId, player::Player>,
    pub vault: u128,
    pub reserved: u128,
    pub machine_reserved: u128,
    pub treasury: u128,
    pub jackpot: u128,
    pub chips_outstanding: u128,
    pub machine_bankroll_total: u128,
    pub welcome_paid: u128,
    pub blessing_day: u64,
    pub blessing_spent: u128,
    pub blessing_cap: u128,
    pub promo_day: u64,
    pub promo_spent: u128,
    pub last_agent_change_ns: u64,
    pub commits: LookupMap<u64, [u8; 32]>,
    pub commit_head: u64,
    pub commit_tail: u64,
    pub bets: LookupMap<u64, player::Bet>,
    pub results: LookupMap<String, player::StoredResult>,
    pub next_bet_id: u64,
    pub pending_bets: u64,
    pub machines: LookupMap<u32, player::Machine>,
    pub plots: LookupMap<u8, u32>,
    pub next_machine_id: u32,
    pub total_players: u32,
    pub mt: mt::MtState,
    pub bj: LookupMap<u64, blackjack::BlackjackHand>,
    pub hosts: hosts::HostState,
    /// v3: Church campaigns (appended last so older state migrates by appending)
    pub camp: campaigns::CampaignState,
}

#[near]
impl Realm {
    #[init]
    pub fn new(
        admin: AccountId,
        dealer: AccountId,
        agent: AccountId,
        chip_yocto: Option<U128>,
        patch: Option<ParamsPatch>,
    ) -> Self {
        let chip = chip_yocto.map(|v| v.0).filter(|v| *v > 0).unwrap_or(DEFAULT_CHIP_YOCTO);
        let mut params = Params::production(chip);
        if let Some(patch) = patch {
            params.apply(&patch);
        } else {
            params.validate();
        }
        Self {
            version: 2,
            roles: Roles { admin, dealer, agent: agent.clone(), oracle_pk: None, paused: false },
            params,
            players: LookupMap::new(b"p"),
            vault: 0,
            reserved: 0,
            machine_reserved: 0,
            treasury: 0,
            jackpot: 0,
            chips_outstanding: 0,
            machine_bankroll_total: 0,
            welcome_paid: 0,
            blessing_day: 0,
            blessing_spent: 0,
            blessing_cap: 0,
            promo_day: 0,
            promo_spent: 0,
            last_agent_change_ns: 0,
            commits: LookupMap::new(b"c"),
            commit_head: 0,
            commit_tail: 0,
            bets: LookupMap::new(b"b"),
            results: LookupMap::new(b"r"),
            next_bet_id: 1,
            pending_bets: 0,
            machines: LookupMap::new(b"m"),
            plots: LookupMap::new(b"l"),
            next_machine_id: 1,
            total_players: 0,
            mt: mt::MtState::new(),
            bj: LookupMap::new(b"j"),
            hosts: hosts::HostState::new(agent.clone()),
            camp: campaigns::CampaignState::new(),
        }
    }

    /// Code upgrade. Same layout: state is kept as is. From v1 (before the AI hosts): `hosts` was appended as the
    /// last field of `Realm`, so the v1 bytes are followed by a fresh `HostState` and decoded as v2.
    /// `priest` names Father Nakamoto's account (defaults to the agent until `set_priest`).
    #[init(ignore_state)]
    pub fn migrate(priest: Option<AccountId>) -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("bad_args"));
        let mut state = migrate_bytes(&raw, priest);
        state.version = state.version.max(3);
        state
    }

    #[payable]
    pub fn deposit(&mut self) {
        self.deposit_inner();
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.withdraw_inner(amount.0)
    }

    #[private]
    pub fn on_withdraw(&mut self, player: AccountId, amount: U128) {
        self.on_withdraw_inner(player, amount.0);
    }

    pub fn claim_welcome(&mut self) {
        self.claim_welcome_inner();
    }

    pub fn set_profile(&mut self, name: String, avatar: String) {
        self.set_profile_inner(name, avatar);
    }

    pub fn enter_realm(&mut self, realm: String) {
        self.enter_realm_inner(realm);
    }

    pub fn complete_tour(&mut self, realm: String) {
        self.complete_tour_inner(realm);
    }

    pub fn place_bet(
        &mut self,
        game: String,
        wager: U128,
        pick: u8,
        client_seed: String,
        machine_id: u32,
    ) -> u64 {
        self.place_bet_inner(game, wager.0, pick, client_seed, machine_id)
    }

    pub fn reveal(&mut self, bet_id: u64, server_seed: String) {
        self.reveal_inner(bet_id, server_seed);
    }

    pub fn claim_timeout(&mut self, bet_id: u64) {
        self.claim_timeout_inner(bet_id);
    }

    /// `hit`, `stand`, or `double`. Only the player, and only on their turn.
    pub fn blackjack_act(&mut self, bet_id: u64, action: String) {
        self.blackjack_act_inner(bet_id, action);
    }

    /// Dealer. Three seeds open the hand. Every later call is the next card, one seed.
    pub fn blackjack_show(&mut self, bet_id: u64, seeds: Vec<String>) {
        self.blackjack_show_inner(bet_id, seeds);
    }

    pub fn get_blackjack(&self, bet_id: u64) -> Option<blackjack::BlackjackView> {
        self.view_blackjack(bet_id)
    }

    pub fn tithe(&mut self, chips: u32) -> u32 {
        self.tithe_inner(chips)
    }

    pub fn offer_luck(&mut self, luck_milli: u32) -> u32 {
        self.offer_luck_inner(luck_milli)
    }

    pub fn light_candle(&mut self) {
        self.light_candle_inner();
    }

    pub fn claim_quest(&mut self, quest_id: String) {
        self.claim_quest_inner(quest_id);
    }

    pub fn create_machine(&mut self, plot: u8, name: String, skin: String, bankroll: U128) -> u32 {
        self.create_machine_inner(plot, name, skin, bankroll.0)
    }

    pub fn fund_machine(&mut self, id: u32, amount: U128) {
        self.fund_machine_inner(id, amount.0);
    }

    pub fn withdraw_machine(&mut self, id: u32, amount: U128) {
        self.withdraw_machine_inner(id, amount.0);
    }

    pub fn commit_batch(&mut self, commits: Vec<String>) {
        self.commit_batch_inner(commits);
    }

    #[payable]
    pub fn seed_vault(&mut self) {
        self.seed_inner("vault");
    }

    #[payable]
    pub fn seed_treasury(&mut self) {
        self.seed_inner("treasury");
    }

    #[payable]
    pub fn seed_jackpot(&mut self) {
        self.seed_inner("jackpot");
    }

    pub fn set_params(&mut self, patch: ParamsPatch) {
        self.set_params_inner(patch);
    }

    pub fn grant_promo(&mut self, player: AccountId, chips: u32) {
        self.grant_promo_inner(player, chips);
    }

    pub fn set_roles(
        &mut self,
        admin: Option<AccountId>,
        dealer: Option<AccountId>,
        agent: Option<AccountId>,
        oracle_pk: Option<String>,
    ) {
        self.assert_admin();
        self.assert_running();
        if let Some(admin) = admin {
            self.roles.admin = admin;
        }
        if let Some(dealer) = dealer {
            self.roles.dealer = dealer;
        }
        if let Some(agent) = agent {
            self.roles.agent = agent;
        }
        if let Some(pk) = oracle_pk {
            if pk.is_empty() {
                self.roles.oracle_pk = None;
            } else {
                let bytes = util::from_hex_32(&pk);
                util::must(bytes.is_some(), "bad_args");
                self.roles.oracle_pk = bytes;
            }
        }
        events::emit("roles_changed", near_sdk::serde_json::json!({
            "admin": self.roles.admin.to_string(),
            "dealer": self.roles.dealer.to_string(),
            "agent": self.roles.agent.to_string(),
        }));
    }

    pub fn pause(&mut self) {
        self.assert_admin();
        self.roles.paused = true;
        events::emit("paused", near_sdk::serde_json::json!({ "paused": true }));
    }

    pub fn unpause(&mut self) {
        self.assert_admin();
        self.roles.paused = false;
        events::emit("paused", near_sdk::serde_json::json!({ "paused": false }));
    }

    // ---- Church campaigns (campaigns.rs) ----
    pub fn create_campaign(&mut self, campaign: campaigns::NewCampaign, expires_ns: near_sdk::json_types::U64, approval: String) -> u32 {
        self.create_campaign_inner(campaign, expires_ns.0, approval)
    }

    pub fn seed_campaign(&mut self, campaign: campaigns::NewCampaign) -> u32 {
        self.seed_campaign_inner(campaign)
    }

    pub fn claim_campaign(&mut self, id: u32, expires_ns: near_sdk::json_types::U64, attestation: String) {
        self.claim_campaign_inner(id, expires_ns.0, attestation);
    }

    pub fn close_campaign(&mut self, id: u32) {
        self.close_campaign_inner(id);
    }

    pub fn get_campaigns(&self, account_id: Option<AccountId>) -> Vec<campaigns::CampaignView> {
        self.campaigns_view(account_id)
    }

    /// admin: take a machine off a plot (refunds its bankroll to the deed owner, burns the deed)
    pub fn release_plot(&mut self, plot: u8) {
        self.release_plot_inner(plot);
    }

    pub fn grant_plot_gate(&mut self, player: AccountId) {
        self.grant_plot_gate_inner(player);
    }

    pub fn set_transfers_enabled(&mut self, enabled: bool) {
        self.set_transfers_inner(enabled);
    }

    pub fn get_player(&self, account_id: AccountId) -> Option<PlayerView> {
        self.view_player(account_id)
    }

    pub fn get_bet(&self, bet_id: u64) -> Option<BetView> {
        self.view_bet(bet_id)
    }

    pub fn get_bets(&self, from_id: u64, limit: u32) -> Vec<Option<BetView>> {
        self.view_bets(from_id, limit)
    }

    pub fn get_bet_result(&self, account_id: AccountId, bet_id: u64) -> Option<BetResultView> {
        self.view_bet_result(account_id, bet_id)
    }

    pub fn get_recent_results(&self, account_id: AccountId) -> Vec<BetResultView> {
        self.view_recent(account_id)
    }

    pub fn get_pools(&self) -> PoolsView {
        self.view_pools()
    }

    pub fn get_params(&self) -> ParamsView {
        self.view_params()
    }

    pub fn get_machine(&self, id: u32) -> Option<MachineView> {
        self.view_machine(id)
    }

    pub fn get_plots(&self) -> Vec<Option<MachineView>> {
        self.view_plots()
    }

    pub fn storage_report(&self) -> StorageReport {
        self.view_storage()
    }
}

#[cfg(test)]
mod tests;

/// Decode stored state, upgrading a v1 layout (no `hosts`) by appending a fresh `HostState`.
pub(crate) fn migrate_bytes(raw: &[u8], priest: Option<AccountId>) -> Realm {
    use near_sdk::borsh;
    if let Ok(mut state) = borsh::from_slice::<Realm>(raw) {
        if let Some(p) = priest {
            state.hosts.priest = p;
        }
        return state;
    }
    let camp = borsh::to_vec(&campaigns::CampaignState::new()).unwrap_or_else(|_| env::panic_str("bad_args"));
    // v2 (hosts, no campaigns): append the campaign state
    let mut v2 = raw.to_vec();
    v2.extend(&camp);
    if let Ok(mut state) = borsh::from_slice::<Realm>(&v2) {
        if let Some(p) = priest {
            state.hosts.priest = p;
        }
        return state;
    }
    // v1 (neither): append both
    let placeholder: AccountId = env::current_account_id();
    let mut bytes = raw.to_vec();
    bytes.extend(borsh::to_vec(&hosts::HostState::new(placeholder)).unwrap_or_else(|_| env::panic_str("bad_args")));
    bytes.extend(&camp);
    let mut state: Realm = borsh::from_slice(&bytes).unwrap_or_else(|_| env::panic_str("bad_args"));
    state.hosts.priest = priest.unwrap_or_else(|| state.roles.agent.clone());
    state
}
