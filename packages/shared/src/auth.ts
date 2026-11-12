/**
 * Username + password accounts (no password ever reaches the server).
 *
 * On the device: PBKDF2-SHA256(password, salt, ITERATIONS) -> 64 bytes. Bytes 0..31 are the ENCRYPTION key (AES-GCM,
 * never leaves the device) that seals the wallet's ed25519 seed; bytes 32..63 are the AUTH key, sent at sign-in.
 * On the server: the salt, sha256(auth key), and the sealed seed. The server returns the sealed seed only to a caller
 * who presents the right auth key (rate-limited), so nobody can download it to guess passwords offline, and the
 * server itself can never decrypt it.
 */
export const AUTH_KDF_ITERATIONS = 600_000;
export const PASSWORD_MIN = 10;

/** what the wallet key signs when an account is created: proves the uploader controls that NEAR account */
export function signupMessage(accountId: string, name: string, saltHex: string, ts: number): string {
  return `cnc-signup:${accountId}:${name}:${saltHex}:${ts}`;
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `At least ${PASSWORD_MIN} characters`;
  if (pw.length > 200) return 'That is too long';
  if (/^(.)\1+$/.test(pw)) return 'Pick something less repetitive';
  return null;
}
