/** Kept in its own module (no Phaser, no window) so Node scripts like scripts/e2e.mjs can import the verifier. */
export class BackendError extends Error { constructor(public code: string, msg: string) { super(msg); } }
