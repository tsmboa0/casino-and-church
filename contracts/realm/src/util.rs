//! Small helpers shared by the contract. Panic codes are the strings in BACKEND_PLAN Appendix B.

#[track_caller]
pub(crate) fn must(cond: bool, code: &'static str) {
    if !cond {
        near_sdk::env::panic_str(code);
    }
}

pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let dig = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&dig);
    out
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

pub(crate) fn from_hex_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = hex_nibble(bytes[i * 2])?;
        let lo = hex_nibble(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Floor division `amount * bps / 10_000`. Amounts here fit; a failure is a bug, not user input.
pub(crate) fn apply_bps(amount: u128, bps: u128) -> u128 {
    amount.checked_mul(bps).expect("bps overflow") / 10_000
}

pub(crate) fn whole_chips(yocto: u128, chip: u128) -> u128 {
    if chip == 0 {
        return 0;
    }
    yocto / chip
}
