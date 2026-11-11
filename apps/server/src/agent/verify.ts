import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Proof checks for a NEAR AI Cloud answer. Mirrors `apps/client/src/ui/aiverify.ts` byte for byte:
 *  1. sha256 of the exact request bytes and the exact response bytes
 *  2. the signed text must be "<model>:<req hash>:<resp hash>" (provider_tee) or "<req hash>:<resp hash>" (gateway)
 *  3. EIP-191 recovery of the signature must give the signing address
 *  4. that address must be the one in the attestation report we fetched with our own nonce
 */
export interface SignatureDoc {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
  signature_kind?: string;
}

export interface ProofCheck {
  ok: boolean;
  requestSha256: string;
  responseSha256: string;
  expectedText: string;
  recovered: string;
  reasons: string[];
}

export const sha256Hex = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** EIP-191 personal_sign recovery. Returns a lowercase 0x address, or '' when the signature is malformed. */
export function recoverSigner(text: string, signatureHex: string): string {
  try {
    const msg = new TextEncoder().encode(text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
    const sig = Buffer.from(signatureHex.replace(/^0x/, ''), 'hex');
    if (sig.length !== 65) return '';
    let v = sig[64]!;
    if (v >= 27) v -= 27;
    const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    return '0x' + hex(keccak_256(pub.slice(1)).slice(12));
  } catch {
    return '';
  }
}

export function checkProof(opts: {
  model: string;
  request: Uint8Array;
  response: Uint8Array;
  signature: SignatureDoc;
  attestedSigner: string | null;
}): ProofCheck {
  const requestSha256 = sha256Hex(opts.request);
  const responseSha256 = sha256Hex(opts.response);
  const kind = opts.signature.signature_kind ?? 'provider_tee';
  const expectedText = kind === 'gateway' ? `${requestSha256}:${responseSha256}` : `${opts.model}:${requestSha256}:${responseSha256}`;
  const reasons: string[] = [];
  if (opts.signature.text !== expectedText) reasons.push('signed text does not match the stored bytes');
  const recovered = recoverSigner(opts.signature.text, opts.signature.signature);
  const lc = (s: string) => s.toLowerCase();
  if (!recovered || lc(recovered) !== lc(opts.signature.signing_address)) reasons.push('signature does not recover the signing address');
  if (!opts.attestedSigner) reasons.push('no attestation on file');
  else if (lc(opts.attestedSigner) !== lc(opts.signature.signing_address)) reasons.push('signer is not the attested enclave key');
  return { ok: reasons.length === 0, requestSha256, responseSha256, expectedText, recovered, reasons };
}
