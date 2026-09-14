import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

@Injectable()
export class WebhookCryptoService {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return /^[0-9a-fA-F]{64}$/.test(this.config.get<string>('WEBHOOK_ENCRYPTION_KEY') ?? '');
  }

  private key(): Buffer {
    if (!this.enabled) throw new Error('SIGNING_UNAVAILABLE');
    return Buffer.from(this.config.getOrThrow<string>('WEBHOOK_ENCRYPTION_KEY'), 'hex');
  }

  generate(): string {
    return randomBytes(32).toString('hex');
  }

  encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  decrypt(encrypted: string): string {
    const data = Buffer.from(encrypted, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }

  sign(secret: string, timestamp: string, body: string): string {
    // The returned secret is used as UTF-8 text by receivers, not hex-decoded bytes.
    return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  }
}
