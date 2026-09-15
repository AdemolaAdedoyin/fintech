import { createHmac, randomUUID } from 'node:crypto';

const [reference, amountMinor, currency, status = 'SUCCEEDED', eventId = randomUUID()] = process.argv.slice(2);
const secret = process.env.MOCK_PROVIDER_WEBHOOK_SECRET;
if (!reference || !amountMinor || !currency || !secret || secret.length < 32) {
  console.error('Usage: MOCK_PROVIDER_WEBHOOK_SECRET=<private secret> node scripts/mock-payment-callback.mjs <reference> <amountMinor> <USD|NGN> [SUCCEEDED|FAILED] [eventId]');
  process.exit(1);
}
const raw = JSON.stringify({ reference, amountMinor, currency, status, eventId });
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`;
const origin = process.env.MOCK_API_ORIGIN ?? 'http://localhost:3000';
const response = await fetch(new URL('/api/v1/payments/webhooks/mock', origin), {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Mock-Timestamp': timestamp, 'Mock-Signature': signature },
  body: raw, signal: AbortSignal.timeout(10000),
});
console.log(`Event ${eventId}: HTTP ${response.status}`);
console.log(await response.text());
process.exitCode = response.ok ? 0 : 1;
