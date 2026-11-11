import { randomBytes } from 'node:crypto';
import type { SignatureDoc } from './verify.ts';

/**
 * NEAR AI Cloud (OpenAI-compatible) with verifiable answers. Recipe verified with live calls on 10 Nov 2026
 * (BACKEND_PLAN R3-2):
 *  - the body is sent as ONE exact byte string and kept; the raw response bytes are kept; neither is re-serialised
 *  - `x-no-aliasing: true` pins the exact model, `accept-encoding: identity` keeps the bytes the enclave hashed
 *  - `enable_thinking: false` (otherwise reasoning eats the budget and `content` is null), JSON mode
 *  - the signature for a chat id comes from /v1/signature; the enclave key comes from /v1/attestation/report
 * The API key is never logged and never leaves the server.
 */
export interface ChatCapture {
  chatId: string;
  request: Buffer;
  response: Buffer;
  content: string;
  tokens: number;
  ms: number;
}

export interface Attestation {
  at: number;
  model: string;
  nonce: string;
  signingAddress: string;
  intelQuoteBytes: number;
  hasGpuEvidence: boolean;
  report: unknown;
}

export class NearAI {
  constructor(private base: string, private key: string, readonly model: string) {}

  get enabled() { return Boolean(this.key); }

  async chat(messages: { role: 'system' | 'user'; content: string }[], opts: { maxTokens: number; temperature: number; timeoutMs?: number }): Promise<ChatCapture> {
    const started = Date.now();
    const request = Buffer.from(JSON.stringify({
      model: this.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
      messages,
    }));
    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      body: request,
      headers: {
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        'x-no-aliasing': 'true',
        'accept-encoding': 'identity',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const response = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`nearai ${res.status}`);
    const body = JSON.parse(response.toString('utf8')) as { id: string; choices?: { message?: { content?: string | null } }[]; usage?: { total_tokens?: number } };
    return {
      chatId: body.id,
      request,
      response,
      content: body.choices?.[0]?.message?.content ?? '',
      tokens: Number(body.usage?.total_tokens ?? 0),
      ms: Date.now() - started,
    };
  }

  /** The enclave's signature over sha256(request):sha256(response). Retries while it is being produced. */
  async signature(chatId: string, waitMs = 10_000): Promise<SignatureDoc | null> {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      try {
        const res = await fetch(`${this.base}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa&model=${encodeURIComponent(this.model)}`, {
          headers: { authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(Math.max(1_000, until - Date.now())),
        });
        if (res.ok) {
          const doc = await res.json() as SignatureDoc;
          if (doc?.signature && doc?.text) return doc;
        }
      } catch { /* retried */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    return null;
  }

  /** A fresh attestation for the model with our own nonce. No key needed. */
  async attest(): Promise<Attestation> {
    const nonce = randomBytes(32).toString('hex');
    const res = await fetch(`${this.base}/attestation/report?model=${encodeURIComponent(this.model)}&provider=near&include_tls_fingerprint=false&signing_algo=ecdsa&nonce=${nonce}`, {
      headers: { 'x-no-aliasing': 'true' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`attestation ${res.status}`);
    const report = await res.json() as { model_attestations?: Record<string, any>[] };
    const match = (report.model_attestations ?? []).find((m) => m.request_nonce === nonce);
    if (!match?.signing_address) throw new Error('attestation did not echo our nonce');
    return {
      at: Date.now(),
      model: this.model,
      nonce,
      signingAddress: String(match.signing_address),
      intelQuoteBytes: String(match.intel_quote ?? '').length / 2,
      hasGpuEvidence: Boolean(match.nvidia_payload),
      report: match,
    };
  }
}

/** Daily token budget shared by decisions and chat (chat has its own sub-cap). Resets at UTC midnight. */
export class TokenBudget {
  private day = '';
  private used = { decide: 0, chat: 0 };
  constructor(private total: number, private chatShare: number) {}

  private roll() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.used = { decide: 0, chat: 0 }; }
  }
  canSpend(kind: 'decide' | 'chat'): boolean {
    this.roll();
    const all = this.used.decide + this.used.chat;
    if (all >= this.total) return false;
    return kind === 'decide' || this.used.chat < this.total * this.chatShare;
  }
  spend(kind: 'decide' | 'chat', tokens: number) { this.roll(); this.used[kind] += tokens; }
  get snapshot() { this.roll(); return { day: this.day, ...this.used, cap: this.total }; }
}
