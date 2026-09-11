process.env.DATABASE_URL ??=
  'postgresql://fintech:fintech_dev@localhost:5433/fintech?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.WEBHOOK_SIGNING_MASTER_SECRET ??=
  'test-webhook-signing-master-secret-that-is-long-enough';
process.env.WEBHOOK_REQUEST_TIMEOUT_MS ??= '1000';
