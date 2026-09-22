import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  const baseEnvironment = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://fintech:fintech@localhost:5432/fintech?schema=public',
    JWT_ACCESS_SECRET: 'a-secure-test-secret-that-is-longer-than-32-characters',
    JWT_ACCESS_TTL_SECONDS: '900',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
  };

  it('validates optional Paystack configuration and live-key isolation', () => {
    expect(() => validateEnvironment({ ...baseEnvironment, PAYMENT_PROVIDER: 'paystack' })).toThrow(
      'PAYSTACK_SECRET_KEY',
    );
    expect(
      validateEnvironment({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'paystack',
        PAYSTACK_SECRET_KEY: 'sk_test_fixture',
      }).PAYMENT_PROVIDER,
    ).toBe('paystack');
    expect(() =>
      validateEnvironment({ ...baseEnvironment, PAYSTACK_SECRET_KEY: 'sk_live_fixture' }),
    ).toThrow('production');
  });

  it('requires HTTPS CORS origins in production', () => {
    expect(() => validateEnvironment({ ...baseEnvironment, NODE_ENV: 'production' })).toThrow(
      'HTTPS',
    );
    expect(
      validateEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
      }).NODE_ENV,
    ).toBe('production');
  });
  it('coerces and returns valid environment values', () => {
    expect(validateEnvironment(baseEnvironment)).toEqual(
      expect.objectContaining({
        NODE_ENV: 'test',
        PORT: 3000,
        JWT_ACCESS_TTL_SECONDS: 900,
        LOG_LEVEL: 'info',
      }),
    );
  });

  it('rejects a missing database URL', () => {
    const environment = { ...baseEnvironment };
    delete (environment as Partial<typeof baseEnvironment>).DATABASE_URL;

    expect(() => validateEnvironment(environment)).toThrow('DATABASE_URL');
  });

  it('rejects weak JWT secrets', () => {
    expect(() =>
      validateEnvironment({ ...baseEnvironment, JWT_ACCESS_SECRET: 'too-short' }),
    ).toThrow('JWT_ACCESS_SECRET');
  });

  it('rejects the documented placeholder JWT secret', () => {
    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        JWT_ACCESS_SECRET: 'replace-with-at-least-32-random-characters',
      }),
    ).toThrow('private random value');
  });

  it('rejects access-token lifetimes outside the allowed range', () => {
    expect(() => validateEnvironment({ ...baseEnvironment, JWT_ACCESS_TTL_SECONDS: '30' })).toThrow(
      'JWT_ACCESS_TTL_SECONDS',
    );
  });
  it('accepts an absent webhook key and rejects malformed keys', () => {
    expect(
      validateEnvironment({ ...baseEnvironment, WEBHOOK_ENCRYPTION_KEY: '' })
        .WEBHOOK_ENCRYPTION_KEY,
    ).toBeUndefined();
    expect(
      validateEnvironment({ ...baseEnvironment, WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32) })
        .WEBHOOK_ENCRYPTION_KEY,
    ).toBe('ab'.repeat(32));
    expect(() =>
      validateEnvironment({ ...baseEnvironment, WEBHOOK_ENCRYPTION_KEY: 'bad-key' }),
    ).toThrow('WEBHOOK_ENCRYPTION_KEY');
  });
  it('keeps mock payments disabled by default and requires a secret when enabled', () => {
    expect(validateEnvironment(baseEnvironment).PAYMENT_PROVIDER).toBe('disabled');
    expect(() => validateEnvironment({ ...baseEnvironment, PAYMENT_PROVIDER: 'mock' })).toThrow(
      'MOCK_PROVIDER_WEBHOOK_SECRET',
    );
    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'mock',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'mock-secret-longer-than-thirty-two-characters',
        NODE_ENV: 'production',
      }),
    ).toThrow('cannot be enabled in production');
    expect(
      validateEnvironment({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'mock',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'mock-secret-longer-than-thirty-two-characters',
      }).PAYMENT_PROVIDER,
    ).toBe('mock');
  });
});
