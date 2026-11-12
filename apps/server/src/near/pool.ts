import {
  ACTION_FUNCTION_CALL, Writer, bytesToHex, delegateActionBytes, keypairFromSecret, parseSecret,
  publicKeyString, signTransaction, transferActionBytes, type SignedDelegate,
} from '@cnc/shared';
import type { NearRpc } from './rpc.ts';
import { txSucceeded } from './rpc.ts';

interface Lane {
  secret: Uint8Array;
  publicKey: Uint8Array;
  nonce: bigint;
  ready: Promise<void>;
}

/** One in-flight transaction per access key, so nonces stay ordered. */
export class KeyPool {
  private lanes: Lane[] = [];
  private cursor = 0;

  constructor(private rpc: NearRpc, private accountId: string, private contractId: string, secrets: string[]) {
    for (const text of secrets) {
      const secret = parseSecret(text);
      const { publicKey } = keypairFromSecret(secret);
      this.lanes.push({ secret, publicKey, nonce: 0n, ready: Promise.resolve() });
    }
  }

  get size() { return this.lanes.length; }
  get signer() { return this.accountId; }

  private pick(): Lane {
    if (!this.lanes.length) throw new Error('no keys');
    const lane = this.lanes[this.cursor % this.lanes.length]!;
    this.cursor++;
    return lane;
  }

  private async withLane<T>(fn: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = this.pick();
    const run = lane.ready.then(() => fn(lane));
    lane.ready = run.then(() => undefined, () => undefined);
    return run;
  }

  private async nonceOf(lane: Lane): Promise<bigint> {
    if (lane.nonce > 0n) return lane.nonce;
    const chain = await this.rpc.accessKeyNonce(this.accountId, publicKeyString(lane.publicKey));
    lane.nonce = chain + 1n;
    return lane.nonce;
  }

  async submit(actions: Uint8Array, receiverId: string): Promise<string> {
    try {
      return await this.submitOnLane(actions, receiverId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/nonce/i.test(message)) throw err;
      return await this.submitOnLane(actions, receiverId);
    }
  }

  private submitOnLane(actions: Uint8Array, receiverId: string): Promise<string> {
    return this.withLane(async (lane) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const nonce = await this.nonceOf(lane);
        const tip = await this.rpc.recentTip();
        const signed = signTransaction(lane.secret, {
          signerId: this.accountId,
          publicKey: lane.publicKey,
          nonce,
          receiverId,
          blockHash: tip.hash,
          actions,
        });
        try {
          const hash = await this.rpc.broadcast(signed);
          lane.nonce = nonce + 1n;
          // never fire-and-forget: watch it land (re-sending if a provider dropped it) and say so if it fails
          void this.rpc.poll(hash, this.accountId, signed).then((tx) => {
            if (!txSucceeded(tx)) console.error(JSON.stringify({ at: 'tx', signer: this.accountId, hash, error: 'failed on chain', status: JSON.stringify(tx?.status).slice(0, 200) }));
          }).catch((err) => {
            lane.nonce = 0n;   // it may never have landed: re-read the nonce before this lane signs again
            console.error(JSON.stringify({ at: 'tx', signer: this.accountId, hash, error: `not seen: ${err instanceof Error ? err.message.slice(0, 120) : err}` }));
          });
          return hash;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lane.nonce = 0n;
          if (attempt === 1 || !/nonce/i.test(message)) throw err;
        }
      }
      throw new Error('nonce');
    });
  }

  submitDelegate(signed: SignedDelegate): Promise<string> {
    return this.submit(delegateActionBytes(signed), signed.delegate.senderId);
  }

  transfer(to: string, yocto: bigint): Promise<string> {
    return this.submit(transferActionBytes(yocto), to);
  }

  call(method: string, args: unknown, gas: bigint): Promise<string> {
    return this.submit(this.functionCall(method, args, gas), this.contractId);
  }

  /** Sign, submit, and wait. A nonce error is retried once on the next key. `deposit` needs a full-access key. */
  callAndWait(method: string, args: unknown, gas: bigint, deposit = 0n): Promise<{ hash: string; tx: any }> {
    return this.callsAndWait([{ method, args, gas, deposit }]);
  }

  /**
   * Several FunctionCall actions in ONE transaction, executed atomically in order (all succeed or all revert).
   * The AI hosts use it to anchor `record_decision` together with the action it justifies.
   */
  async callsAndWait(calls: { method: string; args: unknown; gas: bigint; deposit?: bigint }[]): Promise<{ hash: string; tx: any }> {
    const actions = this.functionCalls(calls);
    const once = () => this.withLane(async (lane) => {
      const nonce = await this.nonceOf(lane);
      const tip = await this.rpc.recentTip();
      const signed = signTransaction(lane.secret, {
        signerId: this.accountId, publicKey: lane.publicKey, nonce, receiverId: this.contractId, blockHash: tip.hash, actions,
      });
      try {
        const done = await this.rpc.submitAndWait(signed, this.accountId);
        lane.nonce = nonce + 1n;
        return done;
      } catch (err) {
        lane.nonce = 0n;
        throw err;
      }
    });
    try {
      return await once();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/nonce/i.test(message)) throw err;
      return await once();
    }
  }

  private functionCall(method: string, args: unknown, gas: bigint): Uint8Array {
    return this.functionCalls([{ method, args, gas }]);
  }

  private functionCalls(calls: { method: string; args: unknown; gas: bigint; deposit?: bigint }[]): Uint8Array {
    const w = new Writer();
    w.u32(calls.length);
    for (const c of calls) {
      w.u8(ACTION_FUNCTION_CALL);
      w.str(c.method);
      w.bytes(new TextEncoder().encode(JSON.stringify(c.args ?? {})));
      w.u64(c.gas);
      w.u128(c.deposit ?? 0n);
    }
    return w.finish();
  }
}

export function keyId(publicKey: Uint8Array): string {
  return bytesToHex(publicKey).slice(0, 8);
}
