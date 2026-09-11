import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  const baseEnvironment = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://fintech:fintech@localhost:5432/fintech?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a-secure-test-secret-that-is-longer-than-32-characters',
    JWT_ACCESS_TTL_SECONDS: '900',
    WEBHOOK_SIGNING_MASTER_SECRET:
      'a-secure-webhook-signing-secret-that-is-longer-than-32-characters',
    WEBHOOK_REQUEST_TIMEOUT_MS: '1000',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
  };

  it('coerces and returns valid environment values', () => {
    expect(validateEnvironment(baseEnvironment)).toEqual(
      expect.objectContaining({
        NODE_ENV: 'test',
        PORT: 3000,
        REDIS_URL: 'redis://localhost:6379',
        JWT_ACCESS_TTL_SECONDS: 900,
        WEBHOOK_REQUEST_TIMEOUT_MS: 1000,
        LOG_LEVEL: 'info',
      }),
    );
  });

  it('rejects a missing database URL', () => {
    const environment = { ...baseEnvironment };
    delete (environment as Partial<typeof baseEnvironment>).DATABASE_URL;

    expect(() => validateEnvironment(environment)).toThrow('DATABASE_URL');
  });

  it('rejects invalid Redis protocols', () => {
    expect(() =>
      validateEnvironment({ ...baseEnvironment, REDIS_URL: 'http://localhost:6379' }),
    ).toThrow('REDIS_URL');
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

  it('rejects weak webhook signing secrets', () => {
    expect(() =>
      validateEnvironment({ ...baseEnvironment, WEBHOOK_SIGNING_MASTER_SECRET: 'too-short' }),
    ).toThrow('WEBHOOK_SIGNING_MASTER_SECRET');
  });

  it('rejects the documented placeholder webhook signing secret', () => {
    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        WEBHOOK_SIGNING_MASTER_SECRET: 'replace-with-a-private-webhook-signing-master-secret',
      }),
    ).toThrow('private random value');
  });

  it('rejects access-token lifetimes outside the allowed range', () => {
    expect(() => validateEnvironment({ ...baseEnvironment, JWT_ACCESS_TTL_SECONDS: '30' })).toThrow(
      'JWT_ACCESS_TTL_SECONDS',
    );
  });

  it('rejects webhook request timeouts outside the allowed range', () => {
    expect(() =>
      validateEnvironment({ ...baseEnvironment, WEBHOOK_REQUEST_TIMEOUT_MS: '100' }),
    ).toThrow('WEBHOOK_REQUEST_TIMEOUT_MS');
  });
});
