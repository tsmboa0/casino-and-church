//! NEP-297 logs. Amounts are decimal strings. No secrets are logged before reveal.

use near_sdk::{env, serde_json::{json, Value}};

pub(crate) fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": "cnc",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}
