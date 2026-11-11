//! Access control. The relayer is not a role: a relayed call executes as the player.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::env;
use near_sdk::AccountId;

use crate::util::must;
use crate::Realm;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Roles {
    pub admin: AccountId,
    pub dealer: AccountId,
    pub agent: AccountId,
    pub oracle_pk: Option<[u8; 32]>,
    pub paused: bool,
}

impl Realm {
    pub(crate) fn predecessor_is(&self, who: &near_sdk::AccountId) -> bool {
        &env::predecessor_account_id() == who
    }

    pub(crate) fn assert_admin(&self) {
        must(self.predecessor_is(&self.roles.admin), "not_allowed");
    }

    pub(crate) fn assert_dealer(&self) {
        let id = env::predecessor_account_id();
        must(id == self.roles.dealer || id == self.roles.admin, "not_allowed");
    }

    pub(crate) fn assert_agent(&self) -> bool {
        let id = env::predecessor_account_id();
        if id == self.roles.admin {
            return true;
        }
        must(id == self.roles.agent, "not_allowed");
        false
    }

    pub(crate) fn assert_running(&self) {
        must(!self.roles.paused, "paused");
    }
}
