import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { WebhookCryptoService } from './webhook-crypto.service';

const service = (key = 'ab'.repeat(32)) =>
  new WebhookCryptoService(new ConfigService({ WEBHOOK_ENCRYPTION_KEY: key }));
describe('Webhook secrets', () => {
  it('encrypts with randomized authenticated ciphertext and decrypts exactly', () => {
    const crypto = service();
    const secret = crypto.generate();
    const encrypted = crypto.encrypt(secret);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(encrypted).not.toBe(crypto.encrypt(secret));
    expect(encrypted).not.toContain(secret);
    expect(crypto.decrypt(encrypted)).toBe(secret);
  });
  it('rejects wrong keys and tampered ciphertext', () => {
    const encrypted = service().encrypt('secret');
    expect(() => service('cd'.repeat(32)).decrypt(encrypted)).toThrow();
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => service().decrypt(bytes.toString('base64'))).toThrow();
  });
  it('signs the exact raw body and timestamp using the returned secret as text', () => {
    const body = '{ "amount": "100" }';
    const expected = createHmac('sha256', 'secret').update(`123.${body}`).digest('hex');
    expect(service().sign('secret', '123', body)).toBe(`v1=${expected}`);
    expect(service().sign('secret', '124', body)).not.toBe(`v1=${expected}`);
    expect(service().sign('secret', '123', '{"amount":"100"}')).not.toBe(`v1=${expected}`);
  });
  it('disables signing when configuration is missing', () => {
    expect(service('').enabled).toBe(false);
    expect(() => service('').encrypt('secret')).toThrow('SIGNING_UNAVAILABLE');
  });
});
