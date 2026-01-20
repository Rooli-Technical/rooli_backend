import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32;
  private readonly ivLength = 16;
  private readonly tagLength = 16;
  private readonly key: Buffer;

  constructor(private config: ConfigService) {
    const encryptionKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    // Derive a 32-byte key from the secret
    this.key = crypto.scryptSync(encryptionKey, 'salt', this.keyLength);
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine IV + AuthTag + Ciphertext
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return combined.toString('base64');
  }

  async decrypt(encryptedData: string): Promise<string> {
    try {
      const combined = Buffer.from(encryptedData, 'base64');

      const iv = combined.slice(0, this.ivLength);
      const authTag = combined.slice(
        this.ivLength,
        this.ivLength + this.tagLength,
      );
      const encrypted = combined.slice(this.ivLength + this.tagLength);

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);


      return decrypted.toString('utf8');
    } catch (error) {
      console.error(error);
      throw new Error('Decryption failed');
    }
  }

  hash(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  generateSecureRandom(length = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  createHmacSignature(data: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  verifyHmacSignature(
    data: string,
    signature: string,
    secret: string,
  ): boolean {
    const expected = this.createHmacSignature(data, secret);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  }
}
