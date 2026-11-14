import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM. Output: base64(iv[12] | tag[16] | ciphertext).
 * `aad` binds the ciphertext to its owner so a row copied onto another user will not decrypt.
 */
export function encrypt(plain: string, masterKeyHex: string, aad: string): string {
  const key = Buffer.from(masterKeyHex, 'hex');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob: string, masterKeyHex: string, aad: string): string {
  const key = Buffer.from(masterKeyHex, 'hex');
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
