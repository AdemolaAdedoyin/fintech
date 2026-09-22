import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const secrets = {
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  MOCK_PROVIDER_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  METRICS_TOKEN: randomBytes(32).toString('hex'),
  PAYMENT_PROVIDER: 'mock',
};
let contents = template;
for (const [name, value] of Object.entries(secrets)) contents = contents.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`);
try {
  await writeFile(new URL('../.env', import.meta.url), contents, {flag: 'wx', mode: 0o600});
  console.log('Created private local .env with mock payments. No secrets printed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved. See .env.example for new optional settings.');
}
