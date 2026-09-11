import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  const baseEnvironment = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://fintech:fintech@localhost:5432/fintech?schema=public',
    JWT_ACCESS_SECRET: 'a-secure-test-secret-that-is-longer-than-32-characters',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
  };

  it('coerces and returns valid environment values', () => {
    expect(validateEnvironment(baseEnvironment)).toEqual(
      expect.objectContaining({
        NODE_ENV: 'test',
        PORT: 3000,
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
});
