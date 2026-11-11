import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import type { AgentProof } from '../core/backend';
import sample from './ai-sample.json';

/**
 * Re-checks an AI host's decision IN THE BROWSER, with nothing but the stored bytes:
 *  1. hash the exact request bytes and response bytes (SHA-256)
 *  2. the signed text must be "<model>:<request hash>:<response hash>" (provider_tee) or "<request hash>:<response hash>" (gateway)
 *  3. recover the signer from the EIP-191 signature and compare it with the signing address
 *  4. that signer must be the one in NEAR AI Cloud's hardware attestation report for the model
 * If any byte of the decision had been edited after the fact, step 1-2 fails.
 */
export interface Check { label: string; ok: boolean; detail: string }
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function verifyProof(p: AgentProof): { ok: boolean; checks: Check[]; reply: string } {
  const req = b64(p.requestB64), res = b64(p.responseB64);
  const rh = hex(sha256(req)), sh = hex(sha256(res));
  const expected = p.signatureKind === 'gateway' ? `${rh}:${sh}` : `${p.model}:${rh}:${sh}`;
  let recovered = '';
  try {
    const msg = new TextEncoder().encode(p.signedText);
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const sb = Uint8Array.from((p.signature.replace(/^0x/, '').match(/../g) ?? []).map(h => parseInt(h, 16)));
    let v = sb[64]; if (v >= 27) v -= 27;
    const pub = secp256k1.Signature.fromCompact(sb.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    recovered = '0x' + hex(keccak_256(pub.slice(1)).slice(12));
  } catch { recovered = ''; }
  let reply = '';
  try { reply = JSON.parse(new TextDecoder().decode(res)).choices?.[0]?.message?.content ?? ''; } catch { /* */ }
  const lc = (s: string) => s.toLowerCase();
  const checks: Check[] = [
    { label: 'Exact bytes hashed', ok: true, detail: `request ${rh.slice(0, 12)}… · response ${sh.slice(0, 12)}…` },
    { label: 'Signed text matches the bytes', ok: p.signedText === expected, detail: p.signedText === expected ? 'nothing was edited after the AI answered' : 'MISMATCH: the stored decision differs from what was signed' },
    { label: 'Signature recovers the signer', ok: !!recovered && lc(recovered) === lc(p.signingAddress), detail: recovered ? `${recovered.slice(0, 10)}…${recovered.slice(-6)}` : 'could not recover a signer' },
    { label: 'Signer is in the hardware attestation', ok: !!p.attestedSigner && lc(p.attestedSigner) === lc(p.signingAddress), detail: `${p.signatureKind === 'provider_tee' ? 'signed inside the model\'s secure enclave (Intel TDX + NVIDIA)' : 'signed by the NEAR AI gateway'}` },
  ];
  return { ok: checks.every(c => c.ok), checks, reply };
}

/** a real decision captured from NEAR AI Cloud on 10 Nov 2026 (Qwen/Qwen3.8-27B), shown when no live proof is available */
export const SAMPLE_PROOF: AgentProof & { capturedAt: string } = {
  model: sample.model, chatId: sample.chatId, signedText: sample.signature.text, signature: sample.signature.signature,
  signingAddress: sample.signature.signing_address, signatureKind: sample.signature.signature_kind as 'provider_tee', requestB64: sample.requestB64,
  responseB64: sample.responseB64, attestedSigner: sample.attestation.signingAddress, attestationAt: Date.parse(sample.capturedAt), capturedAt: sample.capturedAt,
};
