//! Commit–reveal hashing. Pure SHA-256 so unit tests do not need a VM.
//!
//! Reveal:  sha256(server_seed || client_seed || chain_seed || bet_id_le_u64)
//! Timeout: sha256(client_seed || chain_seed || block_random || bet_id_le_u64 || b"timeout")

use crate::util::sha256;

pub(crate) fn mul_shift(draw: u32, n: u32) -> u32 {
    ((u64::from(draw) * u64::from(n)) >> 32) as u32
}

pub(crate) fn draws_of(h: &[u8; 32]) -> [u32; 8] {
    let mut d = [0u32; 8];
    for k in 0..8 {
        let i = k * 4;
        d[k] = u32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
    }
    d
}

pub(crate) fn commit_of(server_seed: &[u8; 32]) -> [u8; 32] {
    sha256(server_seed)
}

pub(crate) fn reveal_hash(server: &[u8; 32], client: &[u8; 32], chain: &[u8; 32], bet_id: u64) -> [u8; 32] {
    let mut buf = [0u8; 104];
    buf[0..32].copy_from_slice(server);
    buf[32..64].copy_from_slice(client);
    buf[64..96].copy_from_slice(chain);
    buf[96..104].copy_from_slice(&bet_id.to_le_bytes());
    sha256(&buf)
}

pub(crate) fn timeout_hash(client: &[u8; 32], chain: &[u8; 32], block_random: &[u8; 32], bet_id: u64) -> [u8; 32] {
    let mut buf = [0u8; 111];
    buf[0..32].copy_from_slice(client);
    buf[32..64].copy_from_slice(chain);
    buf[64..96].copy_from_slice(block_random);
    buf[96..104].copy_from_slice(&bet_id.to_le_bytes());
    buf[104..111].copy_from_slice(b"timeout");
    sha256(&buf)
}
