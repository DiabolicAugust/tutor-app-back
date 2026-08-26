import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Encryption for the credentials in `meeting_accounts`.
 *
 * A refresh token is a standing right to act as somebody on Zoom or Google. In
 * plain text, a database dump — a leaked backup, a support export, a stolen
 * replica — hands over working keys to other people's accounts, which is a
 * worse loss than everything else in this schema put together. Encrypted, the
 * same dump is inert without the key, and the key lives in the environment
 * rather than the database.
 *
 * AES-256-GCM: authenticated, so a value edited in the database fails to decrypt
 * instead of decrypting to something else. A fresh 12-byte IV per value, because
 * reusing one under GCM is the mistake that breaks it outright.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>`, base64url. The version prefix is there
 * so a future key rotation or algorithm change can recognise what it is looking
 * at rather than guess.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export class TokenCipher {
  private readonly key: Buffer;

  /**
   * @param secret Any string with enough entropy — it is hashed to 32 bytes
   * rather than used directly, so an operator setting a long passphrase gets a
   * valid key instead of a length error. The caller is responsible for the
   * entropy; see the env schema, which insists on a minimum length.
   */
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);

    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  /**
   * Returns null rather than throwing when the value cannot be read.
   *
   * Which is not laziness about errors: the realistic causes are a rotated key
   * and a row written by a build using a different one, and the right answer to
   * both is "this connection no longer works, ask the tutor to reconnect". A
   * throw here would instead turn every lesson they book into a 500.
   */
  decrypt(stored: string): string | null {
    const [version, iv, tag, payload] = stored.split('.');
    if (version !== VERSION || !iv || !tag || !payload) return null;

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));

      return Buffer.concat([
        decipher.update(Buffer.from(payload, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
