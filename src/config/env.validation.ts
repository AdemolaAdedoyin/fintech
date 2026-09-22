import { z } from 'zod';

const exampleJwtSecret = 'replace-with-at-least-32-random-characters';

const environmentSchema = z
  .object({
    AUTH_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(60),
    API_DOCS_ENABLED: z.enum(['true', 'false']).optional(),
    METRICS_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    PAYMENT_PROVIDER: z.enum(['disabled', 'mock', 'paystack']).default('disabled'),
    PAYSTACK_SECRET_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^sk_(test|live)_[A-Za-z0-9]+$/)
        .optional(),
    ),
    MOCK_PROVIDER_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
      .refine((secret) => secret !== exampleJwtSecret, {
        message: 'JWT_ACCESS_SECRET must be replaced with a private random value',
      }),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
    CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WEBHOOK_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional(),
    ),
    REDIS_URL: z.string().url().default('redis://localhost:6380'),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === 'production') {
      const origins = config.CORS_ORIGIN.split(',').map((value) => value.trim());
      if (
        !origins.every((value) => {
          try {
            const url = new URL(value);
            return url.protocol === 'https:' && url.origin === value;
          } catch {
            return false;
          }
        })
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'Production requires explicit HTTPS origins without paths',
        });
    }
    if (config.PAYMENT_PROVIDER === 'paystack' && !config.PAYSTACK_SECRET_KEY)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'Paystack secret key is required',
      });
    if (config.NODE_ENV !== 'production' && config.PAYSTACK_SECRET_KEY?.startsWith('sk_live_'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'Live Paystack keys require production mode',
      });
    if (config.PAYMENT_PROVIDER === 'mock' && config.NODE_ENV === 'production') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'Mock payments cannot be enabled in production',
      });
    }
    if (config.PAYMENT_PROVIDER === 'mock' && !config.MOCK_PROVIDER_WEBHOOK_SECRET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MOCK_PROVIDER_WEBHOOK_SECRET'],
        message: 'A private mock webhook secret is required',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(config);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}
