import { randomUUID, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
const origin = process.env.SMOKE_API_ORIGIN ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Smoke test is restricted to loopback');
const secret = process.env.MOCK_PROVIDER_WEBHOOK_SECRET;
if (!secret || process.env.PAYMENT_PROVIDER !== 'mock') throw new Error('Enable mock payments locally before running this smoke test');
async function api(path, body, token, extra={}) {
  const result = await fetch(`${origin}/api/v1${path}`, {method:body ? 'POST':'GET', headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}), ...extra}, body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(10000)});
  if (!result.ok) throw new Error(`${path} returned ${result.status}`);
  return result.json();
}
const register=()=>api('/auth/register',{email:`smoke-${randomUUID()}@example.com`,password:`local-${randomUUID()}`,firstName:'Local',lastName:'Smoke',currency:'NGN'});
const sender=await register(), recipient=await register();
const payment=await api('/payments',{walletId:sender.initialWallet.id,amountMinor:'10000'},sender.accessToken,{'Idempotency-Key':randomUUID()});
const body={eventId:randomUUID(),reference:payment.reference,amountMinor:'10000',currency:'NGN',status:'SUCCEEDED'};
const timestamp=String(Math.floor(Date.now()/1000));
const signature=`v1=${createHmac('sha256',secret).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex')}`;
for(let i=0;i<2;i++) await api('/payments/webhooks/mock',body,undefined,{'Mock-Timestamp':timestamp,'Mock-Signature':signature});
const transfer=await api('/transfers',{sourceWalletId:sender.initialWallet.id,destinationWalletId:recipient.initialWallet.id,amountMinor:'2500'},sender.accessToken,{'Idempotency-Key':randomUUID()});
await api(`/transfers/${transfer.id}/reversal`,{reason:'Local smoke verification'},sender.accessToken,{'Idempotency-Key':randomUUID()});
const wallet=await api(`/wallets/${sender.initialWallet.id}`,undefined,sender.accessToken);
assert.equal(wallet.currentBalanceMinor,'10000');
await api('/health/ready');
if (process.env.METRICS_TOKEN) {
  let complete = false;
  for (let attempt=0; attempt<40; attempt++) {
    const response = await fetch(`${origin}/api/v1/health/metrics`, {headers:{Authorization:`Bearer ${process.env.METRICS_TOKEN}`},signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`Metrics returned ${response.status}`);
    const metrics = await response.text();
    const age = Number(metrics.match(/^fintech_worker_poll_age_seconds (.+)$/m)?.[1] ?? -1);
    if (/^fintech_notification_unpersisted 0$/m.test(metrics) && age >= 0 && age < 60) { complete=true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(complete, 'Worker must persist all outbox notifications and report a recent poll');
}
console.log('PASS: registration, mock funding, replay, transfer, reversal, balance and readiness.');
console.log('Two synthetic local accounts and immutable transaction history were created.');
