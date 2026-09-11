import { z } from 'zod';

const exampleJwtSecret = 'replace-with-at-least-32-random-characters';
const exampleWebhookSecret = 'replace-with-a-private-webhook-signing-master-secret';

const redisUrlSchema = z
  .string()
  .url('REDIS_URL must be a valid URL')
  .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
    message: 'REDIS_URL must use redis:// or rediss://',
  });

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: redisUrlSchema.default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
    .refine((secret) => secret !== exampleJwtSecret, {
      message: 'JWT_ACCESS_SECRET must be replaced with a private random value',
    }),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  WEBHOOK_SIGNING_MASTER_SECRET: z
    .string()
    .min(32, 'WEBHOOK_SIGNING_MASTER_SECRET must be at least 32 characters')
    .refine((secret) => secret !== exampleWebhookSecret, {
      message: 'WEBHOOK_SIGNING_MASTER_SECRET must be replaced with a private random value',
    }),
  WEBHOOK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
