//! Minimal NEP-245 for plot deeds (`deed:machine:<id>`, supply 1).
//! Transfers stay off until an admin enables them. Approvals and `mt_transfer_call` are not implemented.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::Serialize;
use near_sdk::store::LookupMap;
use near_sdk::{env, json_types::U128, near, AccountId, PromiseOrValue};

use crate::events::emit;
use crate::util::must;
use crate::Realm;
use crate::RealmExt;

#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct MtState {
    pub transfers_enabled: bool,
    pub token_ids: Vec<String>,
    pub owners: LookupMap<String, AccountId>,
    pub by_owner: LookupMap<AccountId, Vec<String>>,
}

impl MtState {
    pub fn new() -> Self {
        Self {
            transfers_enabled: false,
            token_ids: Vec::new(),
            owners: LookupMap::new(b"o"),
            by_owner: LookupMap::new(b"w"),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub supply: U128,
    pub metadata: Option<TokenMetadata>,
}

fn deed(machine_id: u32) -> String {
    format!("deed:machine:{machine_id}")
}

impl Realm {
    pub(crate) fn mint_deed(&mut self, machine_id: u32, owner: &AccountId) {
        let token = deed(machine_id);
        must(self.mt.token_ids.len() < 3, "bad_args");
        self.mt.owners.insert(token.clone(), owner.clone());
        self.mt.token_ids.push(token.clone());
        let mut owned = self.mt.by_owner.get(owner).cloned().unwrap_or_default();
        owned.push(token);
        self.mt.by_owner.insert(owner.clone(), owned);
    }

    pub(crate) fn burn_deed(&mut self, machine_id: u32, owner: &AccountId) {
        let token = deed(machine_id);
        self.mt.owners.remove(&token);
        self.mt.token_ids.retain(|t| t != &token);
        if let Some(mut owned) = self.mt.by_owner.get(owner).cloned() {
            owned.retain(|t| t != &token);
            self.mt.by_owner.insert(owner.clone(), owned);
        }
    }

    pub(crate) fn set_transfers_inner(&mut self, enabled: bool) {
        self.assert_admin();
        self.mt.transfers_enabled = enabled;
    }

    fn token_view(&self, token_id: &str) -> Option<Token> {
        let owner = self.mt.owners.get(token_id).cloned()?;
        let title = token_id
            .strip_prefix("deed:machine:")
            .and_then(|id| id.parse::<u32>().ok())
            .and_then(|id| self.machines.get(&id).cloned())
            .map(|m| m.name);
        Some(Token {
            token_id: token_id.to_string(),
            owner_id: owner,
            supply: U128(1),
            metadata: Some(TokenMetadata {
                title,
                description: Some("Founders' Row slot machine deed".into()),
            }),
        })
    }

    fn transfer_one(&mut self, receiver: &AccountId, token_id: &str, amount: u128) {
        must(self.mt.transfers_enabled, "not_allowed");
        must(amount == 1, "bad_args");
        must(receiver != &env::predecessor_account_id(), "bad_args");
        let owner = self.mt.owners.get(token_id).cloned();
        must(owner.is_some(), "bad_args");
        let owner = owner.unwrap();
        must(owner == env::predecessor_account_id(), "not_owner");
        let mut from_list = self.mt.by_owner.get(&owner).cloned().unwrap_or_default();
        from_list.retain(|t| t != token_id);
        self.mt.by_owner.insert(owner, from_list);
        let mut to_list = self.mt.by_owner.get(receiver).cloned().unwrap_or_default();
        to_list.push(token_id.to_string());
        self.mt.by_owner.insert(receiver.clone(), to_list);
        self.mt.owners.insert(token_id.to_string(), receiver.clone());
        if let Some(id) = token_id.strip_prefix("deed:machine:").and_then(|s| s.parse::<u32>().ok()) {
            if let Some(mut machine) = self.machines.get(&id).cloned() {
                machine.owner = receiver.clone();
                self.machines.insert(id, machine);
            }
        }
        emit("roles_changed", near_sdk::serde_json::json!({
            "token_id": token_id,
            "receiver_id": receiver.to_string(),
        }));
    }
}

#[near]
impl Realm {
    pub fn mt_metadata(&self) -> MtContractMetadata {
        MtContractMetadata {
            spec: "mt-0.2.0".into(),
            name: "Casino & Church Deeds".into(),
            symbol: "DEED".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        let ids = if token_ids.len() > 3 { &token_ids[..3] } else { &token_ids };
        ids.iter().map(|id| self.token_view(id)).collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(u128::from(self.mt.owners.get(&token_id).map(|o| o == &account_id).unwrap_or(false)))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().take(8).map(|id| self.mt_balance_of(account_id.clone(), id)).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.mt.owners.get(&token_id).map(|_| U128(1))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().take(8).map(|id| self.mt_supply(id)).collect()
    }

    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<String> {
        let start = from_index.map(|v| v.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(3).min(3) as usize;
        self.mt.token_ids.iter().skip(start).take(limit).cloned().collect()
    }

    pub fn mt_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u32>) -> Vec<String> {
        let owned = self.mt.by_owner.get(&account_id).cloned().unwrap_or_default();
        let start = from_index.map(|v| v.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(3).min(3) as usize;
        owned.into_iter().skip(start).take(limit).collect()
    }

    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        let _ = (memo,);
        must(approval.is_none(), "not_allowed");
        self.transfer_one(&receiver_id, &token_id, amount.0);
    }

    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        let _ = memo;
        must(approvals.is_none(), "not_allowed");
        must(token_ids.len() == amounts.len() && token_ids.len() <= 3, "bad_args");
        for (token, amount) in token_ids.iter().zip(amounts.iter()) {
            self.transfer_one(&receiver_id, token, amount.0);
        }
    }

    /// Marketplace transfer-and-call is intentionally unsupported in v1.
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = (receiver_id, token_id, amount, approval, memo, msg);
        must(false, "not_allowed");
        PromiseOrValue::Value(U128(0))
    }
}
