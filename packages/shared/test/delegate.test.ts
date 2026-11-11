import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import {
  bytesToHex, decodeSignedDelegate, emptyDelegateFixture, encodeSignedDelegate, keypairFromSecret,
  nep461Hash, signDelegate, verifyDelegate, TGAS,
} from '../src/index.ts';

const FIXTURE = (
  '0803000000616161030000006262620100000000010000000000000002000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000'
);

test('delegate fixture matches near-primitives', () => {
  assert.equal(bytesToHex(emptyDelegateFixture()), FIXTURE);
});

test('signed delegate round-trips and verifies', () => {
  const secret = new Uint8Array(32).fill(7);
  const { publicKey } = keypairFromSecret(secret);
  const signed = signDelegate(secret, {
    senderId: bytesToHex(publicKey),
    receiverId: 'realm.testnet',
    actions: [{ methodName: 'place_bet', args: new TextEncoder().encode('{}'), gas: 40n * TGAS, deposit: 0n }],
    nonce: 1n,
    maxBlockHeight: 1_000n,
    publicKey,
  });
  assert.equal(verifyDelegate(signed), true);
  const back = decodeSignedDelegate(encodeSignedDelegate(signed));
  assert.equal(back.delegate.actions[0]!.methodName, 'place_bet');
  assert.equal(back.delegate.actions[0]!.deposit, 0n);
  assert.equal(verifyDelegate(back), true);
  back.signature[0] ^= 1;
  assert.equal(verifyDelegate(back), false);
  assert.equal(nep461Hash(signed.delegate).length, 32);
  assert.equal(ed25519.getPublicKey(secret).length, 32);
});
